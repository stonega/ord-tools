import BigNumber from "bignumber.js";
import BIP32Factory from "bip32";
import * as bitcoin from "bitcoinjs-lib-mpc";
import varuint from "varuint-bitcoin";
import ecc from "@bitcoinerlab/secp256k1";
const rng = require("randombytes");
import { toXOnly } from ".";
import { UTXO_DUST } from "./OrdUnspendOutput";

export function satoshisToAmount(val: number) {
  const num = new BigNumber(val);
  return num.dividedBy(100000000).toFixed(8);
}

export function amountToSaothis(val: any) {
  const num = new BigNumber(val);
  return num.multipliedBy(100000000).toNumber();
}

/**
 * Helper function that produces a serialized witness script
 * https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/test/integration/csv.spec.ts#L477
 */
export function witnessStackToScriptWitness(witness: Buffer[]) {
  let buffer = Buffer.allocUnsafe(0);

  function writeSlice(slice: Buffer) {
    buffer = Buffer.concat([buffer, Buffer.from(slice)]);
  }

  function writeVarInt(i: number) {
    const currentLen = buffer.length;
    const varintLen = varuint.encodingLength(i);

    buffer = Buffer.concat([buffer, Buffer.allocUnsafe(varintLen)]);
    varuint.encode(i, buffer, currentLen);
  }

  function writeVarSlice(slice: Buffer) {
    writeVarInt(slice.length);
    writeSlice(slice);
  }

  function writeVector(vector: Buffer[]) {
    writeVarInt(vector.length);
    vector.forEach(writeVarSlice);
  }

  writeVector(witness);

  return buffer;
}

export async function estimateInscribeFee(
  {
    inscription,
    network,
    address,
    feeRate
  } : {
    inscription: { body: Buffer; contentType: string }
    address: string
    network: any
    feeRate: number
  }
) {
  bitcoin.initEccLib(ecc);
  const bip32 = BIP32Factory(ecc);
  const internalKey = bip32.fromSeed(rng(64), network);
  const internalPubkey = toXOnly(internalKey.publicKey);
  const asm = `${internalPubkey.toString(
    "hex"
  )} OP_CHECKSIG OP_0 OP_IF ${Buffer.from("ord", "utf8").toString(
    "hex"
  )} 01 ${Buffer.from(inscription.contentType, "utf8").toString(
    "hex"
  )} OP_0 ${inscription.body.toString("hex")} OP_ENDIF`;
  const leafScript = bitcoin.script.fromASM(asm);

  const scriptTree = {
    output: leafScript,
  };
  const redeem = {
    output: leafScript,
    redeemVersion: 192,
  };
  const {
    output,
    witness,
    address: receiveAddress,
  } = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree,
    redeem,
    network,
  });
  const tapLeafScript = {
    script: leafScript,
    leafVersion: 192,
    controlBlock: witness![witness!.length - 1],
  };
  const psbt = new bitcoin.Psbt({ network });
  /// Fake input
  psbt.addInput({
    hash: 'e87f2c0a9b4d48e69d23b69256ae5ae15a5b6c04885ec03f4cb4b8eefcd95a27',
    index: 0,
    witnessUtxo: { value: 1000, script: output! },
  });
  psbt.updateInput(0, {
    tapLeafScript: [
      {
        leafVersion: redeem.redeemVersion,
        script: redeem.output,
        controlBlock: witness![witness!.length - 1],
      },
    ],
  });
  psbt.addOutput({ value: UTXO_DUST, address });
  await psbt.signInputAsync(0, internalKey);
  const customFinalizer = (_inputIndex: number, input: any) => {
    const scriptSolution = [input.tapScriptSig[0].signature];
    const witness = scriptSolution
      .concat(tapLeafScript.script)
      .concat(tapLeafScript.controlBlock);

    return {
      finalScriptWitness: witnessStackToScriptWitness(witness),
    };
  };
  psbt.finalizeInput(0, customFinalizer);
  return Math.ceil(psbt.extractTransaction(true).virtualSize() * feeRate);
}