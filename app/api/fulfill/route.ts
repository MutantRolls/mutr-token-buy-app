import { NextRequest, NextResponse } from 'next/server';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

const MUTR_EXCHANGE_RATE_SOL = 380000;
const MUTR_EXCHANGE_RATE_USDC = 5000;
const TOKEN_DECIMALS = parseInt(process.env.NEXT_PUBLIC_TOKEN_DECIMALS!);

function getConnection() {
  return new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC!, 'confirmed');
}

function getCLRKeypair(): Keypair {
  const privateKeyBytes = bs58.decode(process.env.CLR_WALLET_PRIVATE_KEY!);
  return Keypair.fromSecretKey(privateKeyBytes);
}

async function verifyPayment(
  connection: Connection,
  signature: string,
  paymentToken: 'SOL' | 'USDC',
  expectedLamportsOrUnits: number,
  receiverWallet: PublicKey,
  buyerPublicKey: PublicKey,
): Promise<void> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) throw new Error('Transaction not found on-chain');
  if (tx.meta?.err) throw new Error('Payment transaction failed on-chain');

  const accountKeys = tx.transaction.message.getAccountKeys
    ? tx.transaction.message.getAccountKeys().staticAccountKeys
    : (tx.transaction.message as any).accountKeys;

  const receiverIndex = accountKeys.findIndex(
    (k: PublicKey) => k.toBase58() === receiverWallet.toBase58(),
  );
  if (receiverIndex === -1) throw new Error('Receiver wallet not found in transaction');

  if (paymentToken === 'SOL') {
    const preBalance = tx.meta!.preBalances[receiverIndex];
    const postBalance = tx.meta!.postBalances[receiverIndex];
    const received = postBalance - preBalance;
    if (received < expectedLamportsOrUnits * 0.99) {
      throw new Error(`SOL amount mismatch: expected ~${expectedLamportsOrUnits} lamports, got ${received}`);
    }
  } else {
    // For USDC, verify via token balance changes
    const preTokenBalances = tx.meta!.preTokenBalances ?? [];
    const postTokenBalances = tx.meta!.postTokenBalances ?? [];

    const receiverPost = postTokenBalances.find(
      (b) => accountKeys[b.accountIndex]?.toBase58() === receiverWallet.toBase58() ||
        b.owner === receiverWallet.toBase58(),
    );
    const receiverPre = preTokenBalances.find(
      (b) => accountKeys[b.accountIndex]?.toBase58() === receiverWallet.toBase58() ||
        b.owner === receiverWallet.toBase58(),
    );

    const postAmt = parseInt(receiverPost?.uiTokenAmount.amount ?? '0');
    const preAmt = parseInt(receiverPre?.uiTokenAmount.amount ?? '0');
    const received = postAmt - preAmt;

    if (received < expectedLamportsOrUnits * 0.99) {
      throw new Error(`USDC amount mismatch: expected ~${expectedLamportsOrUnits} units, got ${received}`);
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const { paymentSignature, buyerPublicKey: buyerPubkeyStr, paymentToken, inputAmount } = await req.json();

    if (!paymentSignature || !buyerPubkeyStr || !paymentToken || !inputAmount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const parsedAmount = parseFloat(inputAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json({ error: 'Invalid input amount' }, { status: 400 });
    }

    const connection = getConnection();
    const clrKeypair = getCLRKeypair();
    const buyerPublicKey = new PublicKey(buyerPubkeyStr);
    const mutrMint = new PublicKey(process.env.NEXT_PUBLIC_TOKEN_MINT!);
    const receiverWallet = new PublicKey(process.env.NEXT_PUBLIC_RECEIVER_WALLET!);

    // Determine expected payment units for verification
    const expectedUnits =
      paymentToken === 'SOL'
        ? parsedAmount * LAMPORTS_PER_SOL
        : Math.floor(parsedAmount * 1_000_000); // USDC has 6 decimals

    await verifyPayment(connection, paymentSignature, paymentToken, expectedUnits, receiverWallet, buyerPublicKey);

    // Calculate MUTR amount
    const rate = paymentToken === 'SOL' ? MUTR_EXCHANGE_RATE_SOL : MUTR_EXCHANGE_RATE_USDC;
    const mutrAmount = Math.floor(parsedAmount * rate * Math.pow(10, TOKEN_DECIMALS));

    // Get CLR wallet's MUTR token account
    const clrMutrATA = await getAssociatedTokenAddress(mutrMint, clrKeypair.publicKey);

    // Get or create buyer's MUTR token account
    const buyerMutrATA = await getAssociatedTokenAddress(mutrMint, buyerPublicKey);

    const transaction = new Transaction();

    // Create buyer's ATA if it doesn't exist
    try {
      await getAccount(connection, buyerMutrATA);
    } catch {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          clrKeypair.publicKey, // CLR pays for ATA creation
          buyerMutrATA,
          buyerPublicKey,
          mutrMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    transaction.add(
      createTransferInstruction(
        clrMutrATA,
        buyerMutrATA,
        clrKeypair.publicKey,
        mutrAmount,
      ),
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = clrKeypair.publicKey;

    transaction.sign(clrKeypair);
    const mutrSignature = bs58.encode(transaction.signatures[0].signature!);

    try {
      await connection.sendRawTransaction(transaction.serialize());
    } catch (sendError: any) {
      if (!sendError.message?.includes('already been processed')) throw sendError;
    }

    const { blockhash: mutrBlockhash, lastValidBlockHeight: mutrLastValid } =
      await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: mutrSignature, blockhash: mutrBlockhash, lastValidBlockHeight: mutrLastValid },
      'confirmed',
    );

    return NextResponse.json({ mutrSignature, mutrAmount: parsedAmount * rate });
  } catch (error: any) {
    console.error('Fulfill error:', error);
    return NextResponse.json({ error: error.message ?? 'Internal server error' }, { status: 500 });
  }
}
