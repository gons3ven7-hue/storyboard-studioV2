// netlify/functions/analisar-canal.js
// Recebe { url } de um canal do YouTube, puxa dados reais via YouTube Data API,
// e usa o Gemini (camada grátis, com visão) para gerar o perfil de estilo.
//
// Variáveis de ambiente necessárias (Netlify > Site settings > Environment variables):
//   YOUTUBE_API_KEY  -> console.cloud.google.com, ative "YouTube Data API v3"
//   GEMINI_API_KEY   -> aistudio.google.com/apikey  (grátis)

const YT_KEY = process.env.YOUTUBE_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const YT = "https://www.googleapis.com/youtube/v3";

// Troque aqui se quiser um motor mais forte (ex.: "gemini-2.5-pro").
const MODELO = "gemini-2.5-flash";

const INSTRUCAO_PERFIL =
  "Você é diretor de arte e editor sênior de YouTube. Analise o material e produza um perfil de estilo do canal. " +
  "Responda APENAS com JSON válido (sem markdown, sem preâmbulo), com estas chaves em pt-BR e valores concisos:\n" +
  "{estiloVisual, tipoEdicao, ritmoCortes, tipografia, paletaCores, iluminacao, enquadramentos, movimentosCamera, " +
  "transicoes, efeitosSonoros, animacoes, ilustracoes, elementosGraficos, emocao, linguagemVisual, resumo}";

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

// ─── Descobrir o channelId a partir de qualquer formato de link ──────────
async function resolveChannelId(url) {
  const u = String(url).trim();

  // /channel/UC...
  let m = u.match(/channel\/(UC[\w-]+)/);
  if (m) return m[1];

  // @handle  (com ou sem URL completa)
  m = u.match(/@([\w.\-]+)/);
  if (m) {
    const r = await fetch(`${YT}/channels?part=id&forHandle=@${m[1]}&key=${YT_KEY}`);
    const d = await r.json();
    if (d.items?.[0]) return d.items[0].id;
  }

  // /user/nome  ou  /c/nome  -> cai na busca
  m = u.match(/\/(?:user|c)\/([\w.\-]+)/);
  const term = m ? m[1] : u;

  const r = await fetch(`${YT}/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(term)}&key=${YT_KEY}`);
  const d = await r.json();
  if (d.items?.[0]) return d.items[0].snippet.channelId;

  return null;
}

// ─── Coletar dados reais do canal + vídeos recentes ──────────────────────
async function fetchChannelData(channelId) {
  const cr = await fetch(`${YT}/channels?part=snippet,statistics,brandingSettings&id=${channelId}&key=${YT_KEY}`);
  const cd = await cr.json();
  const ch = cd.items?.[0];
  if (!ch) return null;

  const sr = await fetch(`${YT}/search?part=snippet&channelId=${channelId}&order=date&type=video&maxResults=8&key=${YT_KEY}`);
  const sd = await sr.json();
  const videos = (sd.items || []).map((v) => ({
    titulo: v.snippet.title,
    thumb: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.default?.url,
  }));

  return {
    nome: ch.snippet.title,
    descricao: ch.snippet.description,
    inscritos: ch.statistics?.subscriberCount,
    videos,
  };
}

// ─── Baixar thumbnails e converter para base64 (para o Gemini "ver") ─────
async function thumbsAsInline(videos, max = 5) {
  const out = [];
  for (const v of videos.slice(0, max)) {
    if (!v.thumb) continue;
    try {
      const r = await fetch(v.thumb);
      const buf = Buffer.from(await r.arrayBuffer());
      out.push({ inline_data: { mime_type: "image/jpeg", data: buf.toString("base64") } });
    } catch { /* ignora thumb que falhar */ }
  }
  return out;
}

// ─── Gemini: gerar o perfil de estilo em JSON ────────────────────────────
async function styleProfile(channel) {
  const imgs = await thumbsAsInline(channel.videos);

  const instrucao =
    INSTRUCAO_PERFIL + "\n\n" +
    `Canal: ${channel.nome}\n` +
    `Descrição: ${channel.descricao || "(sem descrição)"}\n` +
    `Títulos recentes: ${channel.videos.map((v) => v.titulo).join(" | ")}\n\n` +
    "As imagens anexadas são thumbnails reais dos vídeos recentes — baseie a paleta, tipografia e linguagem visual nelas.";

  const parts = [{ text: instrucao }, ...imgs];

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json",
        maxOutputTokens: 20000, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  const d = await r.json();
  const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return JSON.parse(txt);
}

// ─── Handler ─────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { erro: "Use POST." });
  if (!YT_KEY || !GEMINI_KEY) return json(500, { erro: "Chaves de API não configuradas no servidor." });

  let url, notas, imagens;
  try {
    const b = JSON.parse(event.body);
    url = b.url; notas = b.notas; imagens = b.imagens || [];
  } catch { return json(400, { erro: "Corpo inválido." }); }

  // ── Modo manual: notas escritas e/ou imagens enviadas ──
  if (!url) {
    if (!notas && !imagens.length) return json(400, { erro: "Envie o link, notas ou imagens." });
    try {
      const profile = await styleFromManual(notas, imagens);
      return json(200, { profile });
    } catch (e) {
      return json(500, { erro: "Falha ao montar o perfil.", detalhe: String(e) });
    }
  }

  // ── Modo link ──
  try {
    const channelId = await resolveChannelId(url);
    if (!channelId) return json(404, { erro: "Canal não encontrado a partir desse link." });

    const channel = await fetchChannelData(channelId);
    if (!channel) return json(404, { erro: "Não consegui carregar os dados do canal." });

    const profile = await styleProfile(channel);
    profile.canal = channel.nome;
    profile.linkAnalisado = url;

    return json(200, { profile, canal: channel });
  } catch (e) {
    return json(500, { erro: "Falha ao analisar o canal.", detalhe: String(e) });
  }
}

// ─── Perfil a partir de notas e imagens enviadas pelo usuário ───────────
async function styleFromManual(notas, imagens) {
  const parts = [{
    text: INSTRUCAO_PERFIL +
      "\n\nNotas do dono do canal:\n" + (notas || "(sem notas)") +
      (imagens.length ? "\n\nAs imagens anexadas são referências visuais do canal." : ""),
  }];
  for (const im of imagens.slice(0, 6)) {
    parts.push({ inline_data: { mime_type: im.media || "image/jpeg", data: im.data } });
  }

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json",
        maxOutputTokens: 20000, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return JSON.parse(d.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
}
