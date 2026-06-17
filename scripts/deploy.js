const hre = require("hardhat");

async function main() {
  console.log("Deploying TrustPay contract...");

  const TrustPay = await hre.ethers.getContractFactory("TrustPay");
  const trustPay = await TrustPay.deploy();

  await trustPay.waitForDeployment();

  const address = await trustPay.getAddress();
  console.log(`TrustPay successfully deployed to: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
