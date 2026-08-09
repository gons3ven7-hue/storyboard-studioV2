// netlify/functions/storyboard.js
// Transforma o roteiro em storyboard detalhado, seguindo o perfil de estilo do canal.

const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Troque aqui se quiser um motor mais forte (ex.: "gemini-2.5-pro").
const MODELO = "gemini-2.5-flash";

const TIPOS = "Ilustração 2D, Cartoon, Pixel Art, Anime, Realista, Infográfico, Ícones, Mockup, " +
  "Interface de app, Mapa, Linha do tempo, Documento, Captura de tela, Gráfico, Diagrama, " +
  "Modelagem 3D, Cenário isométrico, Motion Graphics";

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { erro: "Use POST." });
  if (!GEMINI_KEY) return json(500, { erro: "GEMINI_API_KEY não configurada no servidor." });

  let perfil, roteiro, contexto;
  try {
    const b = JSON.parse(event.body);
    perfil = b.perfil; roteiro = b.roteiro; contexto = b.contexto;
  } catch { return json(400, { erro: "Corpo inválido." }); }

  if (!roteiro) return json(400, { erro: "Envie o roteiro." });

  const prompt =
    "Você é simultaneamente diretor de cinema, ilustrador, motion designer e editor profissional.\n" +
    "Transforme o roteiro abaixo em um storyboard EXTREMAMENTE detalhado, fiel ao PERFIL DE ESTILO do canal.\n" +
    "Regras: nunca genérico; preserve a identidade visual; alterne recursos visuais entre cenas para não repetir; " +
    "se algum trecho puder ser mostrado de forma mais interessante, proponha a alternativa criativa; " +
    "para informação abstrata, crie metáforas visuais ou analogias gráficas; " +
    "maximize retenção, dinamismo visual e clareza narrativa; " +
    "o resultado deve permitir que um editor saiba exatamente o que aparece em cada segundo.\n\n" +
    "PERFIL DE ESTILO DO CANAL:\n" + JSON.stringify(perfil || {}) + "\n\n" +
    (contexto ? "CONTEXTO DAS CENAS ANTERIORES:\n" + contexto + "\n\n" : "") +
    "ROTEIRO (quebre em cenas coerentes):\n" + roteiro + "\n\n" +
    "Responda APENAS com um array JSON válido, sem markdown. Cada item:\n" +
    '{"texto": trecho exato do roteiro, "objetivo": informação ou emoção que a cena transmite, ' +
    '"legenda": legenda curta do quadro no estilo storyboard clássico, com 2 ou 3 frases bem curtas ' +
    'descrevendo a ação e o áudio (ex.: "Plano geral da sala. Um aluno ronca. Voz off: eu nunca fiz isso!"), ' +
    '"descricaoVisual": o que aparece na tela incluindo cenário, personagens, objetos, expressões, ' +
    'enquadramento, composição, iluminação, cores e clima, ' +
    '"tipoIlustracao": um de (' + TIPOS + '), ' +
    '"movimentosCamera": zoom in/out, pan, tilt, dolly, tracking, shake, rotação ou movimento cinematográfico, ' +
    '"animacoes": exatamente como os elementos entram e saem (fade, scale, bounce, slide, dissolve, morph, ' +
    'máscaras, parallax, profundidade), ' +
    '"edicao": onde cortar, tempo aproximado da cena em segundos, quando trocar de imagem, quando acelerar, ' +
    'quando desacelerar, quando inserir zoom e efeitos, ' +
    '"elementosGraficos": array (setas, destaques, glow, contornos, partículas, linhas, círculos, texto animado, ' +
    'emojis, indicadores, barras, labels), ' +
    '"sfx": array de efeitos sonoros compatíveis, ' +
    '"musica": clima da trilha nesse momento, ' +
    '"promptIA": prompt em inglês extremamente detalhado para gerar a imagem em Midjourney/Flux/Stable Diffusion, ' +
    'contendo composição, enquadramento, personagens, cenário, objetos, iluminação, cores, estilo artístico, ' +
    'atmosfera, qualidade e nível de detalhamento, consistente com o estilo do canal}';

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.75,
            responseMimeType: "application/json",
            // Alto de propósito: storyboard detalhado é resposta longa.
            maxOutputTokens: 60000,
            // Os modelos 2.5 "pensam" antes de responder, e esse raciocínio gasta
            // o mesmo orçamento da saída. Sem zerar isso, o JSON vem cortado.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    const d = await r.json();
    if (d.error) return json(500, { erro: "Gemini: " + d.error.message });

    const cand = d.candidates?.[0];
    const motivo = cand?.finishReason;

    if (motivo === "MAX_TOKENS") {
      return json(500, {
        erro: "O roteiro gerou mais cenas do que cabe numa resposta só. Mande em trechos menores " +
              "(2 ou 3 parágrafos por vez) — as cenas se acumulam, então o storyboard final fica completo igual.",
      });
    }
    if (motivo === "SAFETY" || motivo === "PROHIBITED_CONTENT") {
      return json(500, { erro: "O Gemini bloqueou esse trecho por filtro de conteúdo. Tente reformular a parte mais pesada." });
    }

    const texto = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
    if (!texto.trim()) {
      return json(500, { erro: "O Gemini devolveu resposta vazia. Tente de novo ou use um trecho menor." });
    }

    let cenas;
    try {
      cenas = JSON.parse(texto);
    } catch {
      const ini = texto.indexOf("["), fim = texto.lastIndexOf("]");
      if (ini === -1 || fim === -1) {
        return json(500, { erro: "A resposta veio incompleta. Tente um trecho menor do roteiro." });
      }
      cenas = JSON.parse(texto.slice(ini, fim + 1));
    }
    if (!Array.isArray(cenas)) cenas = [cenas];
    if (!cenas.length) return json(500, { erro: "Nenhuma cena foi gerada. Tente reformular o trecho." });

    return json(200, { cenas });
  } catch (e) {
    return json(500, { erro: "Não consegui gerar o storyboard.", detalhe: String(e) });
  }
}
