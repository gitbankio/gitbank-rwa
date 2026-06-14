/** Circle CCTP V1 + V2 contract addresses and domain IDs */

// ── Base Mainnet ──────────────────────────────────────────────────────────────
// V1 (legacy — kept for reference)
export const BASE_TOKEN_MESSENGER_V1    = "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962" as const;
export const BASE_MESSAGE_TRANSMITTER_V1 = "0xAD09780d193884d503182aD4588450C416D6F9D4" as const;
// V2 (active — faster attestation)
export const BASE_TOKEN_MESSENGER_V2    = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const;
export const BASE_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as const;
export const USDC_BASE                  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// ── Base Sepolia ───────────────────────────────────────────────────────────────
// V1 (legacy)
export const SEPOLIA_TOKEN_MESSENGER_V1    = "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5" as const;
export const SEPOLIA_MESSAGE_TRANSMITTER_V1 = "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" as const;
// V2 (active)
export const SEPOLIA_TOKEN_MESSENGER_V2    = "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa" as const;
export const SEPOLIA_MESSAGE_TRANSMITTER_V2 = "0xe737e5cebeeba77efe34d4aa090756590b1ce275" as const;
export const USDC_BASE_SEPOLIA             = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

// Convenience aliases (always point to V2)
export const BASE_TOKEN_MESSENGER    = BASE_TOKEN_MESSENGER_V2;
export const BASE_MESSAGE_TRANSMITTER = BASE_MESSAGE_TRANSMITTER_V2;
export const SEPOLIA_TOKEN_MESSENGER    = SEPOLIA_TOKEN_MESSENGER_V2;
export const SEPOLIA_MESSAGE_TRANSMITTER = SEPOLIA_MESSAGE_TRANSMITTER_V2;

// ── Solana Mainnet ────────────────────────────────────────────────────────────
// V1 programs
export const SOLANA_TOKEN_MESSENGER_PROGRAM_V1   = "CCTPiPYPc6AsJuwueEnWgoziqCa6hTZPkaQDt63ScFwd" as const;
export const SOLANA_MESSAGE_TRANSMITTER_PROGRAM_V1 = "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd" as const;
// V2 programs (active — matches V2 EVM contracts)
export const SOLANA_TOKEN_MESSENGER_PROGRAM_V2   = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" as const;
export const SOLANA_MESSAGE_TRANSMITTER_PROGRAM_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC" as const;
export const USDC_SOLANA                           = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;

// Convenience aliases (always point to V2)
export const SOLANA_TOKEN_MESSENGER_PROGRAM      = SOLANA_TOKEN_MESSENGER_PROGRAM_V2;
export const SOLANA_MESSAGE_TRANSMITTER_PROGRAM  = SOLANA_MESSAGE_TRANSMITTER_PROGRAM_V2;

// ── Circle Domain IDs ─────────────────────────────────────────────────────────
export const DOMAIN_BASE   = 6;
export const DOMAIN_SOLANA = 5;

// ── CCTP V2 Finality Thresholds ───────────────────────────────────────────────
/** FINALIZED (2000): self-relay mode; minimumFee=0; Base OP stack finalizes in ~seconds. */
export const FINALITY_THRESHOLD_FINALIZED  = 2000;
/** CONFIRMED (1000): Circle auto-relay mode; minimumFee=1.3 USDC on Base→Solana. */
export const FINALITY_THRESHOLD_CONFIRMED  = 1000;
/** Minimum allowed by V2 TokenMessengerV2 contract. */
export const FINALITY_THRESHOLD_MIN        = 500;

/**
 * Default: FINALIZED (2000) + maxFee=0 + self-relay.
 * Base OP stack produces safe L2 blocks quickly (no need to wait for L1 finality).
 * Circle attests at FINALIZED on Base in ~30-60 seconds.
 */
export const DEFAULT_FINALITY_THRESHOLD = FINALITY_THRESHOLD_FINALIZED;

// ── Circle Attestation API ────────────────────────────────────────────────────
export const CIRCLE_IRIS_API = "https://iris-api.circle.com";

// ── V2 TokenMessengerV2 ABI (7-param depositForBurn) ─────────────────────────
export const TOKEN_MESSENGER_V2_ABI = [
  {
    name: "depositForBurn",
    type: "function",
    inputs: [
      { name: "amount",               type: "uint256" },
      { name: "destinationDomain",    type: "uint32"  },
      { name: "mintRecipient",        type: "bytes32" },
      { name: "burnToken",            type: "address" },
      { name: "destinationCaller",    type: "bytes32" },
      { name: "maxFee",               type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32"  },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── V1 TokenMessenger ABI (kept for legacy reference) ────────────────────────
export const TOKEN_MESSENGER_ABI = [
  {
    name: "depositForBurn",
    type: "function",
    inputs: [
      { name: "amount",            type: "uint256" },
      { name: "destinationDomain", type: "uint32"  },
      { name: "mintRecipient",     type: "bytes32" },
      { name: "burnToken",         type: "address" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── Message Transmitter ABI (same for V1 and V2) ──────────────────────────────
export const MESSAGE_TRANSMITTER_ABI = [
  {
    name: "receiveMessage",
    type: "function",
    inputs: [
      { name: "message",     type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── USDC ERC-20 ABI (approve only) ───────────────────────────────────────────
export const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;
