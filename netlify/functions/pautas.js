// netlify/functions/pautas.js
// Radar de Pauta — gera ideias de vídeo com Gemini.
// Modo "auto": usa Google Search grounding para achar o que está viralizando.
// Modo "colar": trabalha em cima dos tópicos enviados.

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

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { erro: "Use POST." });
  if (!GEMINI_KEY) return json(500, { erro: "GEMINI_API_KEY não configurada no servidor." });

  let modo, estilo, topicos;
  try {
    const b = JSON.parse(event.body);
    modo = b.modo; estilo = b.estilo; topicos = b.topicos;
  } catch { return json(400, { erro: "Corpo inválido." }); }

  const schema =
    'Responda APENAS com um array JSON válido, sem texto fora dele e sem markdown. ' +
    'Cada item: {"assunto": string curto, "calor": inteiro de 1 a 5 indicando quão viral está, ' +
    '"porque": 1 frase de por que está bombando, "gancho": a fala dos primeiros 3 segundos do vídeo, ' +
    '"titulos": array com 3 títulos chamativos, "thumbnail": ideia de thumb em 1 frase, ' +
    '"angulo": o ângulo/opinião para o vídeo render no estilo do canal}. Gere 3 itens. Específico e conciso.';

  const prompt = modo === "auto"
    ? `Você é o produtor de pauta de um canal do YouTube. Estilo do canal: ${estilo}\n\n` +
      `Pesquise o que está VIRALIZANDO no Brasil HOJE — memes, tretas, polêmicas, notícias virais, ` +
      `gente passando vergonha, treta entre famosos e influenciadores. Priorize o mais recente e comentado. ` +
      `Depois transforme em ideias de vídeo para o canal. ${schema}`
    : `Você é o produtor de pauta de um canal do YouTube. Estilo do canal: ${estilo}\n\n` +
      `Estes são os assuntos que estão bombando agora (fornecidos por mim):\n${topicos}\n\n` +
      `Transforme cada um (ou os melhores) em ideias de vídeo para o canal. ${schema}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9 },
  };
  // Busca web só no modo automático. Com tools ativas o Gemini não aceita
  // responseMimeType JSON, por isso o parse é feito extraindo o array do texto.
  if (modo === "auto") body.tools = [{ google_search: {} }];

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const d = await r.json();
    if (d.error) return json(500, { erro: d.error.message || "Erro do Gemini." });

    const texto = (d.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "").join("\n");
    const pautas = extrairArray(texto);
    if (!Array.isArray(pautas) || !pautas.length) return json(500, { erro: "Nenhuma pauta gerada." });

    return json(200, { pautas });
  } catch (e) {
    return json(500, { erro: "Não consegui montar as pautas dessa vez.", detalhe: String(e) });
  }
}
