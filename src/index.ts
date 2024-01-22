import { OrdTransaction, UnspentOutput, toXOnly } from "./OrdTransaction";
import { OrdUnit } from "./OrdUnit";
import { OrdUnspendOutput, UTXO_DUST } from "./OrdUnspendOutput";
import * as bitcoin from "bitcoinjs-lib-mpc";
import {
  calculateInscribeFee,
  satoshisToAmount,
  witnessStackToScriptWitness,
} from "./utils";
import ecc from "@bitcoinerlab/secp256k1";
import BIP32Factory from "bip32";
const rng = require("randombytes");

export * from "./LocalWallet";
export * from "./open_api";
export * from "./utils";

export async function createSendBTC({
  utxos,
  toAddress,
  toAmount,
  wallet,
  network,
  changeAddress,
  receiverToPayFee,
  feeRate,
  pubkey,
  dump,
  enableRBF = true,
}: {
  utxos: UnspentOutput[];
  toAddress: string;
  toAmount: number;
  wallet: any;
  network: any;
  changeAddress: string;
  receiverToPayFee?: boolean;
  feeRate?: number;
  pubkey: string;
  dump?: boolean;
  enableRBF?: boolean;
}) {
  const tx = new OrdTransaction(wallet, network, pubkey, feeRate);
  tx.setEnableRBF(enableRBF);
  tx.setChangeAddress(changeAddress);

  const nonOrdUtxos: UnspentOutput[] = [];
  const ordUtxos: UnspentOutput[] = [];
  utxos.forEach((v) => {
    if (v.ords.length > 0) {
      ordUtxos.push(v);
    } else {
      nonOrdUtxos.push(v);
    }
  });

  tx.addOutput(toAddress, toAmount);

  const outputAmount = tx.getTotalOutput();

  let tmpSum = tx.getTotalInput();
  for (let i = 0; i < nonOrdUtxos.length; i++) {
    const nonOrdUtxo = nonOrdUtxos[i];
    if (tmpSum < outputAmount) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
      continue;
    }

    const fee = await tx.calNetworkFee();
    if (tmpSum < outputAmount + fee) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
    } else {
      break;
    }
  }

  if (nonOrdUtxos.length === 0) {
    throw new Error("Balance not enough");
  }

  if (receiverToPayFee) {
    const unspent = tx.getUnspent();
    if (unspent >= UTXO_DUST) {
      tx.addChangeOutput(unspent);
    }

    const networkFee = await tx.calNetworkFee();
    const output = tx.outputs.find((v) => v.address === toAddress);
    if (output.value < networkFee) {
      throw new Error(
        `Balance not enough. Need ${satoshisToAmount(
          networkFee
        )} BTC as network fee`
      );
    }
    output.value -= networkFee;
  } else {
    const unspent = tx.getUnspent();
    if (unspent <= 0) {
      throw new Error("Balance not enough to pay network fee.");
    }

    // add dummy output
    tx.addChangeOutput(1);

    const networkFee = await tx.calNetworkFee();
    if (unspent < networkFee) {
      throw new Error(
        `Balance not enough. Need ${satoshisToAmount(
          networkFee
        )} BTC as network fee, but only ${satoshisToAmount(unspent)} BTC.`
      );
    }

    const leftAmount = unspent - networkFee;
    if (leftAmount >= UTXO_DUST) {
      // change dummy output to true output
      tx.getChangeOutput().value = leftAmount;
    } else {
      // remove dummy output
      tx.removeChangeOutput();
    }
  }

  const psbt = await tx.createSignedPsbt();
  if (dump) {
    tx.dumpTx(psbt);
  }

  return psbt;
}

export async function createSendOrd({
  utxos,
  toAddress,
  toOrdId,
  wallet,
  network,
  changeAddress,
  pubkey,
  feeRate,
  outputValue,
  dump,
  enableRBF = true,
}: {
  utxos: UnspentOutput[];
  toAddress: string;
  toOrdId: string;
  wallet: any;
  network: any;
  changeAddress: string;
  pubkey: string;
  feeRate?: number;
  outputValue: number;
  dump?: boolean;
  enableRBF?: boolean;
}) {
  const tx = new OrdTransaction(wallet, network, pubkey, feeRate);
  tx.setEnableRBF(enableRBF);
  tx.setChangeAddress(changeAddress);

  const nonOrdUtxos: UnspentOutput[] = [];
  const ordUtxos: UnspentOutput[] = [];
  utxos.forEach((v) => {
    if (v.ords.length > 0) {
      ordUtxos.push(v);
    } else {
      nonOrdUtxos.push(v);
    }
  });

  // find NFT
  let found = false;

  for (let i = 0; i < ordUtxos.length; i++) {
    const ordUtxo = ordUtxos[i];
    if (ordUtxo.ords.find((v) => v.id == toOrdId)) {
      if (ordUtxo.ords.length > 1) {
        throw new Error("Multiple inscriptions! Please split them first.");
      }
      tx.addInput(ordUtxo);
      tx.addOutput(toAddress, ordUtxo.satoshis);
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error("inscription not found.");
  }

  // format NFT
  tx.outputs[0].value = outputValue;

  // select non ord utxo
  const outputAmount = tx.getTotalOutput();
  let tmpSum = tx.getTotalInput();
  for (let i = 0; i < nonOrdUtxos.length; i++) {
    const nonOrdUtxo = nonOrdUtxos[i];
    if (tmpSum < outputAmount) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
      continue;
    }

    const fee = await tx.calNetworkFee();
    if (tmpSum < outputAmount + fee) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
    } else {
      break;
    }
  }

  const unspent = tx.getUnspent();
  if (unspent <= 0) {
    throw new Error("Balance not enough to pay network fee.");
  }

  // add dummy output
  tx.addChangeOutput(1);

  const networkFee = await tx.calNetworkFee();
  if (unspent < networkFee) {
    throw new Error(
      `Balance not enough. Need ${satoshisToAmount(
        networkFee
      )} BTC as network fee, but only ${satoshisToAmount(unspent)} BTC.`
    );
  }

  const leftAmount = unspent - networkFee;
  if (leftAmount >= UTXO_DUST) {
    // change dummy output to true output
    tx.getChangeOutput().value = leftAmount;
  } else {
    // remove dummy output
    tx.removeChangeOutput();
  }

  const psbt = await tx.createSignedPsbt();
  if (dump) {
    tx.dumpTx(psbt);
  }

  return psbt;
}

export async function createSendMultiOrds({
  utxos,
  toAddress,
  toOrdIds,
  wallet,
  network,
  changeAddress,
  pubkey,
  feeRate,
  dump,
  enableRBF = true,
}: {
  utxos: UnspentOutput[];
  toAddress: string;
  toOrdIds: string[];
  wallet: any;
  network: any;
  changeAddress: string;
  pubkey: string;
  feeRate?: number;
  dump?: boolean;
  enableRBF?: boolean;
}) {
  const tx = new OrdTransaction(wallet, network, pubkey, feeRate);
  tx.setEnableRBF(enableRBF);
  tx.setChangeAddress(changeAddress);

  const nonOrdUtxos: UnspentOutput[] = [];
  const ordUtxos: UnspentOutput[] = [];
  utxos.forEach((v) => {
    if (v.ords.length > 0) {
      ordUtxos.push(v);
    } else {
      nonOrdUtxos.push(v);
    }
  });

  // find NFT
  let foundedCount = 0;

  for (let i = 0; i < ordUtxos.length; i++) {
    const ordUtxo = ordUtxos[i];
    if (ordUtxo.ords.find((v) => toOrdIds.includes(v.id))) {
      if (ordUtxo.ords.length > 1) {
        throw new Error(
          "Multiple inscriptions in one UTXO! Please split them first."
        );
      }
      tx.addInput(ordUtxo);
      tx.addOutput(toAddress, ordUtxo.satoshis);
      foundedCount++;
    }
  }

  if (foundedCount != toOrdIds.length) {
    throw new Error("inscription not found.");
  }

  // Do not format NFT
  // tx.outputs[0].value = outputValue;

  // select non ord utxo
  const outputAmount = tx.getTotalOutput();
  let tmpSum = tx.getTotalInput();
  for (let i = 0; i < nonOrdUtxos.length; i++) {
    const nonOrdUtxo = nonOrdUtxos[i];
    if (tmpSum < outputAmount) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
      continue;
    }

    const fee = await tx.calNetworkFee();
    if (tmpSum < outputAmount + fee) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
    } else {
      break;
    }
  }

  const unspent = tx.getUnspent();
  if (unspent <= 0) {
    throw new Error("Balance not enough to pay network fee.");
  }

  // add dummy output
  tx.addChangeOutput(1);

  const networkFee = await tx.calNetworkFee();
  if (unspent < networkFee) {
    throw new Error(
      `Balance not enough. Need ${satoshisToAmount(
        networkFee
      )} BTC as network fee, but only ${satoshisToAmount(unspent)} BTC.`
    );
  }

  const leftAmount = unspent - networkFee;
  if (leftAmount >= UTXO_DUST) {
    // change dummy output to true output
    tx.getChangeOutput().value = leftAmount;
  } else {
    // remove dummy output
    tx.removeChangeOutput();
  }

  const psbt = await tx.createSignedPsbt();
  if (dump) {
    tx.dumpTx(psbt);
  }

  return psbt;
}

export async function createSendMultiBTC({
  utxos,
  receivers,
  wallet,
  network,
  changeAddress,
  feeRate,
  pubkey,
  dump,
  enableRBF = true,
}: {
  utxos: UnspentOutput[];
  receivers: {
    address: string;
    amount: number;
  }[];
  wallet: any;
  network: any;
  changeAddress: string;
  feeRate?: number;
  pubkey: string;
  dump?: boolean;
  enableRBF?: boolean;
}) {
  const tx = new OrdTransaction(wallet, network, pubkey, feeRate);
  tx.setEnableRBF(enableRBF);
  tx.setChangeAddress(changeAddress);

  const nonOrdUtxos: UnspentOutput[] = [];
  const ordUtxos: UnspentOutput[] = [];
  utxos.forEach((v) => {
    if (v.ords.length > 0) {
      ordUtxos.push(v);
    } else {
      nonOrdUtxos.push(v);
    }
  });

  receivers.forEach((v) => {
    tx.addOutput(v.address, v.amount);
  });

  const outputAmount = tx.getTotalOutput();

  let tmpSum = tx.getTotalInput();
  for (let i = 0; i < nonOrdUtxos.length; i++) {
    const nonOrdUtxo = nonOrdUtxos[i];
    if (tmpSum < outputAmount) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
      continue;
    }

    const fee = await tx.calNetworkFee();
    if (tmpSum < outputAmount + fee) {
      tx.addInput(nonOrdUtxo);
      tmpSum += nonOrdUtxo.satoshis;
    } else {
      break;
    }
  }

  if (nonOrdUtxos.length === 0) {
    throw new Error("Balance not enough");
  }

  const unspent = tx.getUnspent();
  if (unspent <= 0) {
    throw new Error("Balance not enough to pay network fee.");
  }

  // add dummy output
  tx.addChangeOutput(1);

  const networkFee = await tx.calNetworkFee();
  if (unspent < networkFee) {
    throw new Error(
      `Balance not enough. Need ${satoshisToAmount(
        networkFee
      )} BTC as network fee, but only ${satoshisToAmount(unspent)} BTC.`
    );
  }

  const leftAmount = unspent - networkFee;
  if (leftAmount >= UTXO_DUST) {
    // change dummy output to true output
    tx.getChangeOutput().value = leftAmount;
  } else {
    // remove dummy output
    tx.removeChangeOutput();
  }

  const psbt = await tx.createSignedPsbt();
  if (dump) {
    tx.dumpTx(psbt);
  }

  return psbt;
}

export async function createSplitOrdUtxo({
  utxos,
  wallet,
  network,
  changeAddress,
  pubkey,
  feeRate,
  dump,
  enableRBF = true,
  outputValue = 546,
}: {
  utxos: UnspentOutput[];
  wallet: any;
  network: any;
  changeAddress: string;
  pubkey: string;
  feeRate?: number;
  dump?: boolean;
  enableRBF?: boolean;
  outputValue?: number;
}) {
  const { psbt } = await createSplitOrdUtxoV2({
    utxos,
    wallet,
    network,
    changeAddress,
    pubkey,
    feeRate,
    dump,
    enableRBF,
    outputValue,
  });
  return psbt;
}

export async function createSplitOrdUtxoV2({
  utxos,
  wallet,
  network,
  changeAddress,
  pubkey,
  feeRate,
  dump,
  enableRBF = true,
  outputValue = 546,
}: {
  utxos: UnspentOutput[];
  wallet: any;
  network: any;
  changeAddress: string;
  pubkey: string;
  feeRate?: number;
  dump?: boolean;
  enableRBF?: boolean;
  outputValue?: number;
}) {
  const tx = new OrdTransaction(wallet, network, pubkey, feeRate);
  tx.setEnableRBF(enableRBF);
  tx.setChangeAddress(changeAddress);

  const nonOrdUtxos: OrdUnspendOutput[] = [];
  const ordUtxos: OrdUnspendOutput[] = [];
  utxos.forEach((v) => {
    const ordUtxo = new OrdUnspendOutput(v, outputValue);
    if (v.ords.length > 0) {
      ordUtxos.push(ordUtxo);
    } else {
      nonOrdUtxos.push(ordUtxo);
    }
  });

  ordUtxos.sort((a, b) => a.getLastUnitSatoshis() - b.getLastUnitSatoshis());

  let lastUnit: OrdUnit = null;
  let splitedCount = 0;
  for (let i = 0; i < ordUtxos.length; i++) {
    const ordUtxo = ordUtxos[i];
    if (ordUtxo.hasOrd()) {
      tx.addInput(ordUtxo.utxo);
      let tmpOutputCounts = 0;
      for (let j = 0; j < ordUtxo.ordUnits.length; j++) {
        const unit = ordUtxo.ordUnits[j];
        if (unit.hasOrd()) {
          tx.addChangeOutput(unit.satoshis);
          lastUnit = unit;
          tmpOutputCounts++;
          splitedCount++;
          continue;
        }
        tx.addChangeOutput(unit.satoshis);
        lastUnit = unit;
      }
    }
  }

  if (!lastUnit.hasOrd()) {
    tx.removeChangeOutput();
  }

  if (lastUnit.satoshis < UTXO_DUST) {
    lastUnit.satoshis = UTXO_DUST;
  }

  // select non ord utxo
  const outputAmount = tx.getTotalOutput();
  let tmpSum = tx.getTotalInput();
  for (let i = 0; i < nonOrdUtxos.length; i++) {
    const nonOrdUtxo = nonOrdUtxos[i];
    if (tmpSum < outputAmount) {
      tx.addInput(nonOrdUtxo.utxo);
      tmpSum += nonOrdUtxo.utxo.satoshis;
      continue;
    }

    const fee = await tx.calNetworkFee();
    if (tmpSum < outputAmount + fee) {
      tx.addInput(nonOrdUtxo.utxo);
      tmpSum += nonOrdUtxo.utxo.satoshis;
    } else {
      break;
    }
  }
  const unspent = tx.getUnspent();
  if (unspent <= 0) {
    throw new Error("Balance not enough to pay network fee.");
  }

  // add dummy output
  tx.addChangeOutput(1);

  const networkFee = await tx.calNetworkFee();
  if (unspent < networkFee) {
    throw new Error(
      `Balance not enough. Need ${satoshisToAmount(
        networkFee
      )} BTC as network fee, but only ${satoshisToAmount(unspent)} BTC.`
    );
  }

  const leftAmount = unspent - networkFee;
  if (leftAmount >= UTXO_DUST) {
    // change dummy output to true output
    tx.getChangeOutput().value = leftAmount;
  } else {
    // remove dummy output
    tx.removeChangeOutput();
  }

  const psbt = await tx.createSignedPsbt();
  if (dump) {
    tx.dumpTx(psbt);
  }

  return { psbt, splitedCount };
}

export async function inscribe({
  address,
  utxos,
  inscription,
  wallet,
  network,
  pubkey,
  feeRate,
  changeAddress,
  dump,
  feeAddress,
  feeAmount,
}: {
  address: string;
  utxos: UnspentOutput[];
  inscription: { body: Buffer; contentType: string };
  wallet: any;
  network: any;
  pubkey: string;
  changeAddress: string;
  feeRate: number;
  dump: boolean;
  feeAddress?: string;
  feeAmount?: number;
}) {
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

  const toAmount = calculateInscribeFee({
    fileSize: inscription.body.length,
    address,
    feeRate,
  });

  const tapLeafScript = {
    script: leafScript,
    leafVersion: 192,
    controlBlock: witness![witness!.length - 1],
  };
  const receivers = [
    {
      address: receiveAddress,
      amount: toAmount,
    },
  ];
  if (feeAddress) {
    receivers.push({
      address: feeAddress,
      amount: feeAmount,
    });
  }

  const fundPsbt = await createSendMultiBTC({
    utxos,
    receivers,
    wallet,
    pubkey,
    network,
    feeRate,
    changeAddress,
    dump: true,
  });

  const fundTx = fundPsbt.extractTransaction();
  const txid = await wallet.pushPsbt(fundTx.toHex());
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: txid,
    index: 0,
    witnessUtxo: { value: toAmount, script: output! },
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
  if (dump) {
    const tx = new OrdTransaction(wallet, network, pubkey, feeRate);
    return tx.dumpTx(psbt);
  }
  return {
    txid,
    psbt,
  };
}
