# Zora Action Provider

This action provider enables AI agents to interact with the [Zora](https://zora.co/) protocol to create cryptocurrencies on the Base blockchain.

## Installation

To use the Zora action provider, you need to install the required dependency:

```bash
npm install @zoralabs/coins-sdk
# or 
pnpm add @zoralabs/coins-sdk
```

## Actions

### createCoin

Creates a new coin on the Zora Protocol.

**Parameters**:

- `name`: The name of the coin to create
- `symbol`: The symbol of the coin to create
- `uri`: The metadata URI for the coin (IPFS URI recommended)
- `payoutRecipient`: The address that will receive creator earnings
- `platformReferrer` (optional): Platform referrer address that earns referral fees
- `initialPurchaseWei` (optional): Initial purchase amount in wei

**Example**:

```typescript
import { ZoraActionProvider } from "@coinbase/agentkit";
import { CdpWalletProvider } from "@coinbase/agentkit";

// Initialize wallet provider
const walletProvider = new CdpWalletProvider({
  clientId: "your-cdp-client-id",
  clientSecret: "your-cdp-client-secret",
  walletId: "your-wallet-id"
});

// Initialize Zora action provider
const zoraProvider = new ZoraActionProvider({
  privateKey: "0x123...", // Private key for the wallet client
  RPC_URL: "https://mainnet.base.org" // Optional RPC URL
});

// Create a coin
const result = await zoraProvider.createCoin(walletProvider, {
  name: "My Awesome Coin",
  symbol: "MAC",
  uri: "ipfs://bafybeigoxzqzbnxsn35vq7lls3ljxdcwjafxvbvkivprsodzrptpiguysy",
  payoutRecipient: "0xYourAddress",
  platformReferrer: "0xOptionalPlatformReferrerAddress", // Optional
  initialPurchaseWei: 0n // Optional: Initial amount to purchase in Wei
});

console.log(result);
```

## Network Support

This action provider supports all EVM-compatible networks, but is designed primarily for use with Base. 