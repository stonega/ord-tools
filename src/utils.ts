import BigNumber from "bignumber.js";
import varuint from "varuint-bitcoin";

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

/// Calculate inscription fee
export function calculateInscribeFee({
  fileSize,
  address,
  feeRate
}: {
  fileSize: number;
  address: string;
  feeRate: number
}) {
  const inscriptionBalance = 546; // the balance in each inscription
  const fileCount = 1; // the fileCount
  const contentTypeSize = 100; // the size of contentType

  const balance = inscriptionBalance * fileCount;

  let addrSize = 25 + 1; // p2pkh
  if (address.indexOf("bc1q") == 0 || address.indexOf("tb1q") == 0) {
    addrSize = 22 + 1;
  } else if (address.indexOf("bc1p") == 0 || address.indexOf("tb1p") == 0) {
    addrSize = 34 + 1;
  } else if (address.indexOf("2") == 0 || address.indexOf("3") == 0) {
    addrSize = 23 + 1;
  }

  const baseSize = 88;
  let networkSats = Math.ceil(
    ((fileSize + contentTypeSize) / 4 + (baseSize + 8 + addrSize + 8 + 23)) *
      feeRate
  );
  if (fileCount > 1) {
    networkSats = Math.ceil(
      ((fileSize + contentTypeSize) / 4 +
        (baseSize +
          8 +
          addrSize +
          (35 + 8) * (fileCount - 1) +
          8 +
          23 +
          (baseSize + 8 + addrSize + 0.5) * (fileCount - 1))) *
        feeRate
    );
  }

  const total = balance + networkSats;
  return total
}
