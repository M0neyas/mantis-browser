// Generátor QR kódu (bez knihoven, nic se nestahuje): bajtový režim, oprava chyb M (~15 %),
// verze 1–15 (adresa do 412 bajtů v UTF-8). Postup podle ISO/IEC 18004 a veřejné referenční
// implementace Projektu Nayuki (MIT) – Reed-Solomon, rozložení bloků, maskování.
// mantisQr(text) → { size, modules: boolean[y][x] } nebo null (adresa je moc dlouhá).

/* exported mantisQr, mantisQrSvg */

const QR_EC_M = {
  // verze: [ECC bajtů na blok, [počet bloků, datových bajtů v bloku], …]
  1: [10, [1, 16]], 2: [16, [1, 28]], 3: [26, [1, 44]], 4: [18, [2, 32]], 5: [24, [2, 43]],
  6: [16, [4, 27]], 7: [18, [4, 31]], 8: [22, [2, 38], [2, 39]], 9: [22, [3, 36], [2, 37]],
  10: [26, [4, 43], [1, 44]], 11: [30, [1, 50], [4, 51]], 12: [22, [6, 36], [2, 37]],
  13: [22, [8, 37], [1, 38]], 14: [24, [4, 40], [5, 41]], 15: [24, [5, 41], [5, 42]],
};
const QR_ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
  9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
};

function qrGfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function qrRsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = qrGfMul(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = qrGfMul(root, 0x02);
  }
  return result;
}

function qrRsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= qrGfMul(coef, factor); });
  }
  return result;
}

function qrMask(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
}

function mantisQr(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 0;
  let layout = null;
  for (let v = 1; v <= 15; v++) {
    layout = QR_EC_M[v];
    const dataBytes = layout.slice(1).reduce((sum, [count, len]) => sum + count * len, 0);
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (headerBits + bytes.length * 8 <= dataBytes * 8) {
      version = v;
      break;
    }
  }
  if (!version) {
    return null;
  }
  const eccLen = layout[0];
  const groups = layout.slice(1);
  const dataCapacity = groups.reduce((sum, [count, len]) => sum + count * len, 0);

  // Bity: režim 0100, délka, data, ukončení, doplnění na bajty, výplň EC 11
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) {
    push(b, 8);
  }
  push(0, Math.min(4, dataCapacity * 8 - bits.length));
  push(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < dataCapacity * 8; pad ^= 0xec ^ 0x11) {
    push(pad, 8);
  }
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }

  // Bloky + Reed-Solomon, prokládání
  const divisor = qrRsDivisor(eccLen);
  const blocks = [];
  let offset = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + len);
      offset += len;
      blocks.push({ data: block, ecc: qrRsRemainder(block, divisor) });
    }
  }
  const codewords = [];
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.data.length) {
        codewords.push(block.data[i]);
      }
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (const block of blocks) {
      codewords.push(block.ecc[i]);
    }
  }

  // Matice a funkční vzory
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }
  const align = QR_ALIGN[version];
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
      return;
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }));

  const drawFormat = mask => {
    const value = (0 << 3) | mask; // M = 00
    let rem = value;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const f = ((value << 10) | rem) ^ 0x5412;
    const bit = i => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) {
      setFn(8, i, bit(i));
    }
    setFn(8, 7, bit(6));
    setFn(8, 8, bit(7));
    setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) {
      setFn(14 - i, 8, bit(i));
    }
    for (let i = 0; i < 8; i++) {
      setFn(size - 1 - i, 8, bit(i));
    }
    for (let i = 8; i < 15; i++) {
      setFn(8, size - 15 + i, bit(i));
    }
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const v = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) !== 0;
      const a = size - 11 + i % 3;
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // Data cik-cak zespodu zprava (sloupec 6 je časování)
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && index < codewords.length * 8) {
          modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
          index++;
        }
      }
    }
  }

  // Maska s nejmenší penalizací (pravidla 1, 2 a 4 normy)
  const applyMask = mask => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && qrMask(mask, x, y)) {
          modules[y][x] = !modules[y][x];
        }
      }
    }
  };
  const penalty = () => {
    let score = 0;
    let dark = 0;
    for (let a = 0; a < size; a++) {
      for (const horizontal of [true, false]) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = horizontal ? modules[a][b] : modules[b][a];
          const prev = horizontal ? modules[a][b - 1] : modules[b - 1][a];
          if (cur === prev) {
            run++;
          } else {
            score += run >= 5 ? run - 2 : 0;
            run = 1;
          }
        }
        score += run >= 5 ? run - 2 : 0;
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        dark += modules[y][x] ? 1 : 0;
        if (y < size - 1 && x < size - 1) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
            score += 3;
          }
        }
      }
    }
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty();
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(mask); // zpět (XOR)
  }
  applyMask(best);
  drawFormat(best);
  return { size, version, mask: best, modules };
}

// SVG s tichou zónou 4 moduly (tmavé moduly jako jedna cesta)
function mantisQrSvg(qr) {
  const n = qr.size + 8;
  let path = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) {
        path += `M${x + 4} ${y + 4}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

if (typeof module !== "undefined") {
  module.exports = { mantisQr, mantisQrSvg };
}
