// netlify/functions/pautas.js
// Radar de Pauta — ideias de vídeo baseadas no que está em alta.
//
// REGRA CENTRAL: nada de assunto inventado.
// No modo automático a busca web é obrigatória. Se o Gemini não devolver metadados
// de grounding (prova de que pesquisou de verdade), a resposta é recusada em vez de
// entregar tendências fabricadas.

const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Troque aqui se quiser um motor mais forte (ex.: "gemini-2.5-pro").
const MODELO = "gemini-2.5-flash";

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

function extrairArray(texto) {
  const ini = texto.indexOf("[");
  const fim = texto.lastIndexOf("]");
  if (ini === -1 || fim === -1) throw new Error("Resposta sem JSON.");
  return JSON.parse(texto.slice(ini, fim + 1));
}

// Extrai as fontes reais que o Gemini consultou.
function extrairFontes(cand) {
  const gm = cand?.groundingMetadata;
  if (!gm) return [];
  const chunks = gm.groundingChunks || [];
  return chunks
    .map((c) => ({ titulo: c.web?.title || "", url: c.web?.uri || "" }))
    .filter((f) => f.url);
}

const CAMPOS =
  '{"assunto": nome curto do que está acontecendo, ' +
  '"calor": inteiro 1 a 5 de quão quente está, ' +
  '"porque": 1 frase sobre por que está em alta AGORA, ' +
  '"ondeBombou": onde isso está circulando (TikTok, X, Instagram, YouTube...), ' +
  '"quando": quando aconteceu (ex.: "ontem", "essa semana"), ' +
  '"gancho": a fala dos primeiros 3 segundos do vídeo, ' +
  '"titulos": array com 3 títulos, ' +
  '"thumbnail": ideia de thumb em 1 frase, ' +
  '"angulo": como ESTE canal deve abordar, considerando o formato dele}';

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { erro: "Use POST." });
  if (!GEMINI_KEY) return json(500, { erro: "GEMINI_API_KEY não configurada no servidor." });

  let modo, formato, estilo, plataformas, topicos;
  try {
    const b = JSON.parse(event.body);
    modo = b.modo;
    formato = b.formato || "";
    estilo = b.estilo || "";
    plataformas = b.plataformas || "";
    topicos = b.topicos || "";
  } catch { return json(400, { erro: "Corpo inválido." }); }

  const perfilCanal =
    `FORMATO DO CANAL: ${formato || "não informado"}\n` +
    `DESCRIÇÃO DO CANAL: ${estilo || "não informada"}\n` +
    `As pautas precisam caber NESTE formato. Se um assunto quente não render um bom vídeo ` +
    `neste formato específico, descarte e traga outro que renda. O ângulo deve ser o que ` +
    `este canal faria, não um comentário genérico.`;

  // ── Modo manual: o usuário fornece os assuntos ──
  if (modo === "colar") {
    if (!topicos.trim()) return json(400, { erro: "Cole pelo menos um tópico." });
    const prompt =
      `Você é o produtor de pauta de um canal do YouTube.\n\n${perfilCanal}\n\n` +
      `Assuntos que estão em alta (fornecidos pelo dono do canal):\n${topicos}\n\n` +
      `Transforme os melhores em ideias de vídeo. Não invente fatos além do que foi dito: ` +
      `se você não sabe um detalhe, deixe o campo genérico em vez de inventar nome, número ou data.\n` +
      `Responda APENAS com um array JSON, sem markdown. Cada item: ${CAMPOS}. Gere 3 itens.`;

    try {
      const d = await gemini({ prompt, buscar: false });
      if (d.error) return json(500, { erro: d.error.message });
      const texto = textoDe(d);
      return json(200, { pautas: extrairArray(texto), verificado: false, fontes: [] });
    } catch (e) {
      return json(500, { erro: "Não consegui montar as pautas.", detalhe: String(e) });
    }
  }

  // ── Modo automático: busca web obrigatória ──
  const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  const prompt =
    `Hoje é ${hoje}.\n\n` +
    `Use a busca do Google AGORA para descobrir o que está viralizando no Brasil nos últimos dias: ` +
    `${plataformas || "TikTok, Instagram, X e YouTube"}. Procure memes do momento, tretas entre ` +
    `criadores, polêmicas, trends, assuntos mais comentados.\n\n` +
    `REGRAS OBRIGATÓRIAS:\n` +
    `1. Use SOMENTE assuntos que você realmente encontrou nos resultados da busca.\n` +
    `2. É PROIBIDO inventar tretas, nomes, números, datas ou acontecimentos. Nada de exemplo hipotético.\n` +
    `3. Se a busca trouxer pouca coisa, devolva menos itens. Melhor 1 pauta real que 3 inventadas.\n` +
    `4. Se não encontrar NADA confiável e recente, devolva um array vazio: []\n\n` +
    `${perfilCanal}\n\n` +
    `Transforme o que encontrou em ideias de vídeo para este canal.\n` +
    `Responda APENAS com um array JSON, sem markdown. Cada item: ${CAMPOS}. No máximo 4 itens.`;

  try {
    const d = await gemini({ prompt, buscar: true });
    if (d.error) return json(500, { erro: d.error.message });

    const cand = d.candidates?.[0];
    const fontes = extrairFontes(cand);

    // Sem fontes = o modelo não pesquisou de verdade. Não entregamos invenção.
    if (!fontes.length) {
      return json(200, {
        pautas: [],
        verificado: false,
        fontes: [],
        aviso: "A busca na web não retornou resultados desta vez, então não tenho como garantir que " +
               "as pautas seriam reais — preferi não inventar. Tente de novo em instantes ou use " +
               "\"Colar tópicos\" com assuntos que você já viu circulando.",
      });
    }

    const pautas = extrairArray(textoDe(d));
    return json(200, { pautas, verificado: true, fontes });
  } catch (e) {
    return json(500, { erro: "Não consegui buscar as tendências agora.", detalhe: String(e) });
  }
};

// ─── Chamada ao Gemini ───────────────────────────────────────────────────
async function gemini({ prompt, buscar }) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: buscar ? 0.4 : 0.85 },
  };
  // Com tools ativas o Gemini não aceita responseMimeType JSON;
  // por isso o array é extraído do texto.
  if (buscar) body.tools = [{ google_search: {} }];

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  return r.json();
}

function textoDe(d) {
  return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
}
