import { z } from "zod";

export const CreateCoinSchema = z
  .object({
    name: z.string().describe("The name of the coin to create"),
    symbol: z.string().describe("The symbol of the coin to create"),
    uri: z.string().describe("The metadata URI for the coin (IPFS URI recommended)"),
    payoutRecipient: z.string().describe("The address that will receive creator earnings"),
    platformReferrer: z.string().optional().describe("Optional platform referrer address that earns referral fees"),
    initialPurchaseWei: z.bigint().optional().describe("Optional initial purchase amount in wei"),
  })
  .strip()
  .describe("Instructions for creating a new coin on Zora"); 