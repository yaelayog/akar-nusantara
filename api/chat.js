// ══════════════════════════════════════════════════════
//  Akar Nusantara — Vercel Serverless Function
//  Endpoint: POST /api/chat
//  API key Gemini disimpan di environment variable Vercel
//  Tidak pernah terekspos ke frontend/publik
// ══════════════════════════════════════════════════════

const GEMINI_MODEL    = 'gemini-2.5-flash-preview-05-20';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Rate limit: max request per IP per hari
const RATE_LIMIT_PER_DAY = 20;

// Simpan rate limit di memory (reset saat function cold start)
// Untuk produksi skala besar, gunakan KV Store seperti Vercel KV
const rateLimitStore = new Map();

const SYSTEM_PROMPT = `Kamu adalah asisten ahli ekologi mangrove yang berspesialisasi pada ekosistem mangrove Teluk Balikpapan, Kalimantan Timur, Indonesia.

Tugasmu:
1. Membantu identifikasi spesies mangrove berdasarkan deskripsi morfologi atau foto.
2. Menjelaskan pemanfaatan tradisional dan inovatif oleh masyarakat pesisir Balikpapan.
3. Memberikan informasi ekologi dan konservasi yang relevan.

Spesies dominan di Teluk Balikpapan:
- Avicennia alba (Api-api Putih): daun elips memanjang, bawah keputihan, pneumatophore seperti paku. Manfaat: obat luka bakar, tepung biji, pakan ternak.
- Rhizophora apiculata (Bakau Minyak): akar tunjang, daun hijau tua tangkai merah, propagul ramping panjang. Manfaat: tepung propagul, bahan bangunan, pewarna coklat batik, obat diare.
- Rhizophora mucronata (Bakau Hitam/Mucrova): ujung daun berduri kecil, propagul gemuk pendek. Manfaat: kopi mucrova, pewarna merah, ecoprinting, antidiabetes.
- Sonneratia alba (Pedada): daun bulat tebal, buah dengan kelopak bintang merah-hijau. Manfaat: sirup buah, campuran sambal, antioksidan.

Format jawaban:
- Bahasa Indonesia yang ramah dan mudah dipahami
- Maksimal 300 kata kecuali diminta detail
- Gunakan bullet point untuk daftar
- Bold untuk nama spesies
- Jika tidak yakin, minta ciri tambahan`;

// ── Helper: ambil IP pengunjung ──
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── Helper: cek & update rate limit ──
function checkRateLimit(ip) {
  const now     = Date.now();
  const dayMs   = 24 * 60 * 60 * 1000;
  const record  = rateLimitStore.get(ip);

  if (!record || now - record.resetAt > dayMs) {
    // Reset counter
    rateLimitStore.set(ip, { count: 1, resetAt: now });
    return { allowed: true, remaining: RATE_LIMIT_PER_DAY - 1 };
  }

  if (record.count >= RATE_LIMIT_PER_DAY) {
    const resetIn = Math.ceil((record.resetAt + dayMs - now) / 1000 / 60);
    return { allowed: false, remaining: 0, resetIn };
  }

  record.count += 1;
  rateLimitStore.set(ip, record);
  return { allowed: true, remaining: RATE_LIMIT_PER_DAY - record.count };
}

// ── Main handler ──
export default async function handler(req, res) {

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Hanya terima POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cek API key tersedia di environment
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server belum dikonfigurasi. Hubungi administrator.' });
  }

  // Rate limiting
  const ip          = getIP(req);
  const rateResult  = checkRateLimit(ip);

  if (!rateResult.allowed) {
    return res.status(429).json({
      error: `Batas harian tercapai. Coba lagi dalam ${rateResult.resetIn} menit.`,
      resetIn: rateResult.resetIn
    });
  }

  // Ambil body request
  const { history, message, imageBase64, imageMime } = req.body || {};

  if (!message && !imageBase64) {
    return res.status(400).json({ error: 'Pesan atau foto diperlukan.' });
  }

  // Validasi ukuran gambar (max ~4MB base64)
  if (imageBase64 && imageBase64.length > 5_500_000) {
    return res.status(400).json({ error: 'Ukuran foto terlalu besar. Maksimal 4MB.' });
  }

  // Bangun konten user
  const userParts = [];
  if (imageBase64) {
    userParts.push({
      inline_data: {
        mime_type: imageMime || 'image/jpeg',
        data: imageBase64
      }
    });
  }
  userParts.push({
    text: message || 'Tolong identifikasi mangrove dalam foto ini dan jelaskan pemanfaatannya.'
  });

  // Bangun history percakapan (max 10 giliran)
  const safeHistory = Array.isArray(history) ? history.slice(-10) : [];
  const contents    = [...safeHistory, { role: 'user', parts: userParts }];

  try {
    const geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7
        }
      })
    });

    const data = await geminiRes.json();

    if (data.error) {
      console.error('Gemini error:', data.error);
      return res.status(502).json({
        error: 'Layanan AI sedang bermasalah. Silakan coba beberapa saat lagi.'
      });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Maaf, tidak ada respons.';

    return res.status(200).json({
      reply,
      remaining: rateResult.remaining
    });

  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(503).json({
      error: 'Gagal menghubungi layanan AI. Periksa koneksi dan coba lagi.'
    });
  }
}