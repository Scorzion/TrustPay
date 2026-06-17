use std::env;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use dotenv::dotenv;
use ethers::prelude::*;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Executor, Row};
use redis::AsyncCommands;
use serde::{Serialize, Deserialize};
use bigdecimal::{BigDecimal, FromPrimitive};
use futures_util::StreamExt;

// Generate strongly-typed contract bindings using abigen!
abigen!(
    TrustPayContract,
    "../artifacts/contracts/TrustPay.sol/TrustPay.json",
    event_derives(serde::Deserialize, serde::Serialize)
);

#[derive(Serialize, Deserialize, Debug, Clone)]
struct PubSubEvent {
    escrow_id: i32,
    status: String,
    tx_hash: String,
}

// Custom lock helper using Redis (Redlock concept for single Redis node)
async fn acquire_lock(redis_client: &redis::Client, resource: &str, ttl_secs: u64) -> Result<String, anyhow::Error> {
    let mut conn = redis_client.get_async_connection().await?;
    let val = uuid::Uuid::new_v4().to_string();
    
    // SET resource val NX EX ttl
    let res: Option<String> = redis::cmd("SET")
        .arg(resource)
        .arg(&val)
        .arg("NX")
        .arg("EX")
        .arg(ttl_secs)
        .query_async(&mut conn)
        .await?;

    if res.is_some() {
        Ok(val)
    } else {
        Err(anyhow::anyhow!("Lock already held or failed to acquire"))
    }
}

async fn release_lock(redis_client: &redis::Client, resource: &str, val: &str) -> Result<(), anyhow::Error> {
    let mut conn = redis_client.get_async_connection().await?;
    
    // Lua script for atomic unlock (checks val before deleting)
    let script = redis::Script::new(r#"
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    "#);

    let _res: i32 = script
        .key(resource)
        .arg(val)
        .invoke_async(&mut conn)
        .await?;

    Ok(())
}

// Reputation rating calculation logic
async fn update_reputation(pool: &PgPool, user_id: i32) -> Result<(), anyhow::Error> {
    // Formula: Score = Sum(Value * Weight) / Sum(Value)
    // Query completion and dispute results for the user
    let history = sqlx::query(
        "SELECT score_change, escrow_id FROM reputation_history WHERE user_id = $1"
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    if history.is_empty() {
        return Ok(());
    }

    // Default base score is 5.0
    let mut total_score = 5.0;
    for record in history {
        let score_change: f64 = record.get("score_change");
        total_score += score_change;
    }

    // Clip score between 0.0 and 10.0
    if total_score < 0.0 { total_score = 0.0; }
    if total_score > 10.0 { total_score = 10.0; }

    sqlx::query(
        "UPDATE users SET reputation_score = $1 WHERE id = $2"
    )
    .bind(total_score)
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn log_reputation_history(
    pool: &PgPool,
    user_id: i32,
    escrow_id: i32,
    score_change: f64,
    event_type: &str,
) -> Result<(), anyhow::Error> {
    sqlx::query(
        "INSERT INTO reputation_history (user_id, escrow_id, score_change, type, created_at) VALUES ($1, $2, $3, $4, NOW())"
    )
    .bind(user_id)
    .bind(escrow_id)
    .bind(score_change)
    .bind(event_type)
    .execute(pool)
    .await?;

    update_reputation(pool, user_id).await?;
    Ok(())
}

// Main transition processing function (enforces state constraints & append-only audit trails)
async fn process_state_transition(
    pool: &PgPool,
    redis_client: &redis::Client,
    onchain_id: i32,
    new_state: &str,
    tx_hash: &str,
    amount_wei: U256,
) -> Result<(), anyhow::Error> {
    let resource_lock = format!("lock:escrow:onchain:{}", onchain_id);
    
    // Acquire distributed lock on Redis (TTL 10s)
    let mut attempts = 0;
    let lock_val = loop {
        match acquire_lock(redis_client, &resource_lock, 10).await {
            Ok(val) => break val,
            Err(_) => {
                attempts += 1;
                if attempts > 5 {
                    return Err(anyhow::anyhow!("Redis lock acquisition timed out for escrow {}", onchain_id));
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    };

    // Execute state machine transition under a PostgreSQL transaction
    let result = async {
        let mut tx = pool.begin().await?;

        // Retrieve existing escrow
        let escrow = sqlx::query(
            "SELECT id, status::text AS status, version, buyer_id, freelancer_id, balance FROM escrows WHERE onchain_id = $1"
        )
        .bind(onchain_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(escrow) = escrow {
            let escrow_id: i32 = escrow.get("id");
            let previous_state: String = escrow.get("status");
            let escrow_version: i32 = escrow.get("version");
            let buyer_id: i32 = escrow.get("buyer_id");
            let freelancer_id: i32 = escrow.get("freelancer_id");
            let balance: BigDecimal = escrow.get("balance");
            
            // Check if state transition is redundant
            if previous_state == new_state {
                println!("Escrow {} already in state {}. Skipping.", onchain_id, new_state);
                return Ok(());
            }

            // Convert U256 to BigDecimal for Postgres Decimal
            let amount_decimal = BigDecimal::from_u128(amount_wei.as_u128())
                .ok_or_else(|| anyhow::anyhow!("Decimal conversion failed"))?
                / BigDecimal::from(10u64.pow(18)); // Scale down from Wei to Ether

            let new_balance = match new_state {
                "FUNDED" => amount_decimal.clone(),
                "RELEASED" | "RESOLVED" => BigDecimal::from(0),
                _ => balance,
            };

            // Enforce optimistic concurrency control
            let updated_rows = sqlx::query(
                "UPDATE escrows SET status = $1::\"EscrowStatus\", balance = $2, tx_hash = $3, version = version + 1 WHERE id = $4 AND version = $5"
            )
            .bind(new_state)
            .bind(new_balance)
            .bind(tx_hash)
            .bind(escrow_id)
            .bind(escrow_version)
            .execute(&mut *tx)
            .await?
            .rows_affected();

            if updated_rows == 0 {
                return Err(anyhow::anyhow!("Optimistic locking failure: Escrow {} modified in parallel", onchain_id));
            }

            // Write into append-only AuditLog
            sqlx::query(
                "INSERT INTO audit_logs (escrow_id, previous_state, new_state, actor_role, tx_hash, created_at) VALUES ($1, $2, $3, $4, $5, NOW())"
            )
            .bind(escrow_id)
            .bind(previous_state)
            .bind(new_state)
            .bind("SYSTEM")
            .bind(tx_hash)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;

            // Post-commit side effects: Reputation updates
            if new_state == "RELEASED" {
                // Freelancer successfully resolved milestone
                log_reputation_history(pool, freelancer_id, escrow_id, 0.5, "COMPLETION").await?;
            } else if new_state == "RESOLVED" {
                // Dispute resolution outcome (simplification: penalize freelancer on dispute resolution)
                log_reputation_history(pool, freelancer_id, escrow_id, -0.5, "DISPUTE_LOSS").await?;
                log_reputation_history(pool, buyer_id, escrow_id, 0.2, "DISPUTE_WIN").await?;
            }

            // Publish message to Redis Pub/Sub for frontend updates
            let mut redis_conn = redis_client.get_async_connection().await?;
            let pubsub_event = PubSubEvent {
                escrow_id,
                status: new_state.to_string(),
                tx_hash: tx_hash.to_string(),
            };
            let payload = serde_json::to_string(&pubsub_event)?;
            let _: () = redis_conn.publish("escrow_updates", payload).await?;

            println!("Successfully processed transition: Escrow {} -> {}", onchain_id, new_state);
        } else {
            println!("Escrow with on-chain ID {} not found in database. Retrying on next block.", onchain_id);
        }
        Ok(())
    }
    .await;

    // Release Redis lock
    release_lock(redis_client, &resource_lock, &lock_val).await?;
    result
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    dotenv().ok();
    println!("Starting TrustPay Watcher Service...");

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let rpc_url = env::var("RPC_URL").unwrap_or_else(|_| "ws://127.0.0.1:8545".to_string());
    let contract_address_str = env::var("CONTRACT_ADDRESS").expect("CONTRACT_ADDRESS must be set");

    // Connect to PostgreSQL
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    println!("Connected to PostgreSQL.");

    // Connect to Redis
    let redis_client = redis::Client::open(redis_url)?;
    println!("Connected to Redis.");

    // Connect to Polygon / Hardhat RPC
    let provider = Provider::<Ws>::connect(rpc_url).await?;
    let provider = Arc::new(provider);
    println!("Connected to Ethereum WebSocket Provider.");

    let contract_address: Address = contract_address_str.parse()?;
    let contract = TrustPayContract::new(contract_address, provider.clone());

    // Main event listening loops
    if let Err(e) = listen_events(contract, pool, redis_client).await {
        eprintln!("Event stream error: {:?}", e);
    }

    Ok(())
}

async fn listen_events(
    contract: TrustPayContract<Provider<Ws>>,
    pool: PgPool,
    redis_client: redis::Client
) -> Result<(), anyhow::Error> {
    let event_funded = contract.event::<EscrowFundedFilter>();
    let event_released = contract.event::<FundsReleasedFilter>();
    let event_disputed = contract.event::<DisputeRaisedFilter>();
    let event_resolved = contract.event::<DisputeResolvedFilter>();
    let event_refunded = contract.event::<RefundedFilter>();

    let mut stream_funded = event_funded.stream().await?.with_meta().fuse();
    let mut stream_released = event_released.stream().await?.with_meta().fuse();
    let mut stream_disputed = event_disputed.stream().await?.with_meta().fuse();
    let mut stream_resolved = event_resolved.stream().await?.with_meta().fuse();
    let mut stream_refunded = event_refunded.stream().await?.with_meta().fuse();

    println!("Watching for smart contract events...");

    loop {
        tokio::select! {
            Some(Ok((log, meta))) = stream_funded.next() => {
                let tx_hash = format!("{:?}", meta.transaction_hash);
                println!("Caught EscrowFunded event. Tx: {}", tx_hash);
                let onchain_id = log.escrow_id.as_u32() as i32;
                if let Err(e) = process_state_transition(&pool, &redis_client, onchain_id, "FUNDED", &tx_hash, log.amount).await {
                    eprintln!("Failed to process EscrowFunded: {:?}", e);
                }
            }
            Some(Ok((log, meta))) = stream_released.next() => {
                let tx_hash = format!("{:?}", meta.transaction_hash);
                println!("Caught FundsReleased event. Tx: {}", tx_hash);
                let onchain_id = log.escrow_id.as_u32() as i32;
                if let Err(e) = process_state_transition(&pool, &redis_client, onchain_id, "RELEASED", &tx_hash, log.amount).await {
                    eprintln!("Failed to process FundsReleased: {:?}", e);
                }
            }
            Some(Ok((log, meta))) = stream_disputed.next() => {
                let tx_hash = format!("{:?}", meta.transaction_hash);
                println!("Caught DisputeRaised event. Tx: {}", tx_hash);
                let onchain_id = log.escrow_id.as_u32() as i32;
                if let Err(e) = process_state_transition(&pool, &redis_client, onchain_id, "DISPUTED", &tx_hash, U256::zero()).await {
                    eprintln!("Failed to process DisputeRaised: {:?}", e);
                }
            }
            Some(Ok((log, meta))) = stream_resolved.next() => {
                let tx_hash = format!("{:?}", meta.transaction_hash);
                println!("Caught DisputeResolved event. Tx: {}", tx_hash);
                let onchain_id = log.escrow_id.as_u32() as i32;
                if let Err(e) = process_state_transition(&pool, &redis_client, onchain_id, "RESOLVED", &tx_hash, log.amount).await {
                    eprintln!("Failed to process DisputeResolved: {:?}", e);
                }
            }
            Some(Ok((log, meta))) = stream_refunded.next() => {
                let tx_hash = format!("{:?}", meta.transaction_hash);
                println!("Caught Refunded event. Tx: {}", tx_hash);
                let onchain_id = log.escrow_id.as_u32() as i32;
                if let Err(e) = process_state_transition(&pool, &redis_client, onchain_id, "RESOLVED", &tx_hash, log.amount).await {
                    eprintln!("Failed to process Refunded: {:?}", e);
                }
            }
        }
    }
}
