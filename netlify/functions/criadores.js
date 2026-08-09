// netlify/functions/criadores.js
// O que os criadores estão realmente postando AGORA.
//
// Fonte: YouTube Data API v3 (dados oficiais, não raspagem).
//  - chart=mostPopular  → os vídeos em alta no Brasil neste momento
//  - search recente     → vídeos do nicho publicados nos últimos dias, ordenados por views
//
// O Gemini NÃO descobre nada aqui. Ele só lê a lista real de vídeos e identifica
// os temas que se repetem, transformando em pauta para o formato do canal.

const YT_KEY = process.env.YOUTUBE_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const YT = "https://www.googleapis.com/youtube/v3";

// Troque aqui se quiser um motor mais forte (ex.: "gemini-2.5-pro").
const MODELO = "gemini-2.5-flash";

// Categorias do YouTube por formato de canal.
const CATEGORIA = {
  "Toon vlog": "1", "Vlog": "22", "Gameplay": "20", "Curiosidades": "27",
  "Comentário / reação": "24", "Storytime": "22", "Tutorial": "26",
  "Review": "28", "Notícias": "25", "Humor / esquete": "23",
  "Podcast / cortes": "22", "Documentário": "27",
};

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

function nUm(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".0", "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}
function diasAtras(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "hoje";
  if (d === 1) return "ontem";
  return `há ${d} dias`;
}

// ─── Vídeos em alta no Brasil ────────────────────────────────────────────
async function emAlta(categoria) {
  let url = `${YT}/videos?part=snippet,statistics&chart=mostPopular&regionCode=BR` +
            `&maxResults=40&key=${YT_KEY}`;
  if (categoria) url += `&videoCategoryId=${categoria}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return (d.items || []).map((v) => ({
    titulo: v.snippet.title,
    canal: v.snippet.channelTitle,
    views: nUm(v.statistics?.viewCount),
    publicado: v.snippet.publishedAt,
    id: v.id,
  }));
}

// ─── Vídeos recentes do nicho, ordenados por views ───────────────────────
async function recentesDoNicho(termo, dias) {
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const s = await fetch(
    `${YT}/search?part=snippet&q=${encodeURIComponent(termo)}&type=video&order=viewCount` +
    `&publishedAfter=${desde}&regionCode=BR&relevanceLanguage=pt&maxResults=25&key=${YT_KEY}`
  );
  const sd = await s.json();
  if (sd.error) throw new Error(sd.error.message);
  const ids = (sd.items || []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return [];

  const v = await fetch(`${YT}/videos?part=snippet,statistics&id=${ids.join(",")}&key=${YT_KEY}`);
  const vd = await v.json();
  return (vd.items || []).map((x) => ({
    titulo: x.snippet.title,
    canal: x.snippet.channelTitle,
    views: nUm(x.statistics?.viewCount),
    publicado: x.snippet.publishedAt,
    id: x.id,
  })).sort((a, b) => b.views - a.views);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { erro: "Use POST." });
  if (!YT_KEY) return json(500, { erro: "YOUTUBE_API_KEY não configurada no servidor." });
  if (!GEMINI_KEY) return json(500, { erro: "GEMINI_API_KEY não configurada no servidor." });

  let formato, estilo, nicho, dias;
  try {
    const b = JSON.parse(event.body);
    formato = b.formato || "";
    estilo = b.estilo || "";
    nicho = (b.nicho || "").trim();
    dias = Math.min(30, Math.max(1, Number(b.dias) || 7));
  } catch { return json(400, { erro: "Corpo inválido." }); }

  try {
    const categoria = CATEGORIA[formato] || null;

    // Junta as duas fontes: alta geral do país + recentes do nicho.
    const [alta, recentes] = await Promise.all([
      emAlta(categoria).catch(() => []),
      nicho ? recentesDoNicho(nicho, dias).catch(() => []) : Promise.resolve([]),
    ]);

    // Deduplica por id e ordena por views.
    const mapa = {};
    [...recentes, ...alta].forEach((v) => { mapa[v.id] = v; });
    const videos = Object.values(mapa).sort((a, b) => b.views - a.views).slice(0, 40);

    if (!videos.length) {
      return json(200, {
        pautas: [], videos: [],
        aviso: "O YouTube não retornou vídeos para esse filtro. Tente sem o campo de nicho, " +
               "ou escolha outro formato de canal.",
      });
    }

    // Lista real entregue ao modelo — ele não busca nada, só interpreta.
    const lista = videos.map((v, i) =>
      `${i + 1}. "${v.titulo}" — ${v.canal} — ${fmt(v.views)} views — ${diasAtras(v.publicado)}`
    ).join("\n");

    const prompt =
      `Abaixo está a lista REAL de vídeos que estão performando no YouTube Brasil agora ` +
      `(dados oficiais da API do YouTube, coletados neste instante):\n\n${lista}\n\n` +
      `FORMATO DO CANAL: ${formato || "não informado"}\n` +
      `DESCRIÇÃO DO CANAL: ${estilo || "não informada"}\n` +
      (nicho ? `NICHO PESQUISADO: ${nicho}\n` : "") + `\n` +
      `Sua tarefa: identificar os TEMAS e FORMATOS que os criadores estão explorando nessa lista ` +
      `— o que se repete, que tipo de assunto está rendendo, que ângulos estão funcionando — ` +
      `e transformar isso em pautas para ESTE canal.\n\n` +
      `REGRAS:\n` +
      `1. Baseie-se APENAS nos vídeos da lista acima. Não invente assunto que não esteja lá.\n` +
      `2. Não copie um título: identifique o tema por trás e adapte ao formato do canal.\n` +
      `3. Se um tema não couber no formato deste canal, descarte e use outro da lista.\n` +
      `4. Em "baseadoEm", cite o(s) vídeo(s) da lista que motivaram a pauta.\n\n` +
      `Responda APENAS com um array JSON, sem markdown. 4 itens. Cada item:\n` +
      `{"assunto": tema em poucas palavras, ` +
      `"calor": inteiro 1 a 5 conforme o quanto o tema aparece/performa na lista, ` +
      `"porque": por que esse tema está rendendo agora, ` +
      `"baseadoEm": título(s) real(is) da lista que embasam essa pauta, ` +
      `"gancho": fala dos primeiros 3 segundos, ` +
      `"titulos": array com 3 títulos, ` +
      `"thumbnail": ideia de thumb em 1 frase, ` +
      `"angulo": como este canal, no formato dele, deve abordar}`;

    const g = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, responseMimeType: "application/json",
            maxOutputTokens: 30000, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const gd = await g.json();
    if (gd.error) return json(500, { erro: gd.error.message });

    const texto = (gd.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
    let pautas = JSON.parse(texto);
    if (!Array.isArray(pautas)) pautas = [pautas];

    // Devolve também os vídeos reais, para o usuário conferir a origem.
    const amostra = videos.slice(0, 12).map((v) => ({
      titulo: v.titulo, canal: v.canal,
      views: fmt(v.views), quando: diasAtras(v.publicado),
      url: "https://www.youtube.com/watch?v=" + v.id,
    }));

    return json(200, { pautas, videos: amostra, total: videos.length });
  } catch (e) {
    return json(500, { erro: "Não consegui ler as tendências do YouTube.", detalhe: String(e) });
  }
};
