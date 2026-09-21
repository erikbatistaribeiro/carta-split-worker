/**
 * Cloudflare Worker — Gerar Carta de Autorização Split de Pagamento
 *
 * Variáveis de ambiente (Settings → Variables → Encrypt):
 *   PIPEFY_TOKEN   — token Bearer do Pipefy
 *   WORKER_SECRET  — chave secreta para proteger o endpoint
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const PIPEFY_API = "https://api.pipefy.com/graphql";
const FIELD_ID   = "anexo_carta_de_aturoiza_o";
const ORG_ID     = 300738585;

const PAGE_W     = 595.28;
const PAGE_H     = 841.89;
const ML         = 85;
const MT         = 71;
const CONTENT_W  = PAGE_W - ML - 85;

// ─── Handler principal ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    console.info({ message: "Carta Split Worker recebeu uma requisicao" });

    if (request.method === "OPTIONS") return cors();

    const url = new URL(request.url);
    if (url.pathname !== "/gerar-carta") return json({ error: "Not found" }, 404);
    if (request.method !== "POST")       return json({ error: "Method not allowed" }, 405);

    const secret = request.headers.get("X-Worker-Secret");
    if (!env.WORKER_SECRET || secret !== env.WORKER_SECRET) return json({ error: "Unauthorized" }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Body JSON invalido" }, 400); }

    const cardId = body.card_id;
    if (!cardId) return json({ error: "card_id e obrigatorio" }, 400);

    try {
      const dados = await buscarDadosCard(cardId, env.PIPEFY_TOKEN);
      const pdfBytes = await gerarPdf(dados);
      await anexarPdfNoPipefy(cardId, dados.cpf, pdfBytes, env.PIPEFY_TOKEN);
      return json({ ok: true, card_id: cardId, msg: "Carta gerada e anexada com sucesso." });
    } catch (err) {
      console.error("Erro:", err.message);
      return json({ ok: false, error: err.message }, 500);
    }
  }
};

// ─── Busca campos do card no Pipefy ───────────────────────────────────────
async function buscarDadosCard(cardId, token) {
  const query = `query { card(id: "${cardId}") { fields { name value } } }`;
  const res  = await pipefyFetch(query, token);
  const card = res.data?.card;
  if (!card) throw new Error(`Card ${cardId} nao encontrado`);

  const c = {};
  for (const f of card.fields || []) if (f.value) c[f.name] = f.value;

  return {
    dataCarta:   formatarDataPortugues(c["Data Emissão da Carta"] || ""),
    valorTotal:  c["Valor total dos boletos"] || "",
    idContrato:  c["ID do contrato CCB"]      || "",
    dataContrato:formatarDataDDMMYYYY(c["Data emissão do contrato CCB"] || ""),
    dadosBoleto: parseBoletos(c["Dados Boleto"] || ""),
    nomeCliente: c["Nome do Cliente"]         || "",
    cpf:         c["CPF do Cliente"]          || "",
  };
}

function parseBoletos(texto) {
  if (!texto) return [];
  const vistos = new Set();
  return texto.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
    .filter(b => { if (vistos.has(b)) return false; vistos.add(b); return true; })
    .map(bloco => ({
      razao:    extrair(bloco, /Raz.o Social\/Nome do Favorecido:\s*(.*)/i),
      cnpj:     extrair(bloco, /CNPJ\/CPF:\s*(.*)/i),
      boleto:   extrair(bloco, /Boleto:\s*(.*)/i),
      contrato: extrair(bloco, /Contrato:\s*(.*)/i),
      valor:    extrair(bloco, /Valor:\s*(.*)/i),
    })).filter(b => b.razao);
}

function extrair(t, r) { return t.match(r)?.[1]?.trim() || ""; }

// ─── Geração do PDF ────────────────────────────────────────────────────────
async function gerarPdf(d) {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const fR   = await doc.embedFont(StandardFonts.TimesRoman);
  const fB   = await doc.embedFont(StandardFonts.TimesRomanBold);
  const FS   = 12;
  const LS   = FS * 1.5;
  const K    = rgb(0, 0, 0);
  let y      = PAGE_H - MT;

  const draw = (text, font, x) => {
    page.drawText(san(text), { x, y, size: FS, font, color: K });
  };

  function line(text, bold = false, sp = 0) {
    y -= sp;
    if (!text) { y -= LS; return; }
    draw(text, bold ? fB : fR, ML);
    y -= LS;
  }

  function center(text, bold = false, sp = 0) {
    y -= sp;
    const f  = bold ? fB : fR;
    const tw = f.widthOfTextAtSize(san(text), FS);
    draw(text, f, (PAGE_W - tw) / 2);
    y -= LS;
  }

  function para(text, sp = 0) {
    y -= sp;
    for (const l of wrap(san(text), fR, FS, CONTENT_W)) {
      draw(l, fR, ML);
      y -= LS;
    }
  }

  function mixed(prefix, value, sp = 0) {
    y -= sp;
    const pw = fB.widthOfTextAtSize(san(prefix), FS);
    draw(prefix, fB, ML);
    draw(value,  fR, ML + pw);
    y -= LS;
  }

  // Conteúdo da carta
  mixed("Sao Paulo, SP, ", `${d.dataCarta}.`);
  line("");
  line("A");
  line("BMP SOCIEDADE DE CREDITO DIRETO S.A.", true);
  line("", false, LS);
  center("AUTORIZACAO", true);
  line("");

  para(`Autorizamos a transferencia do montante de ${d.valorTotal}, oriundo do Valor Liquido de Credito da CCB no ${d.idContrato}, emitida em ${d.dataContrato} para os seguintes destinatarios:`);
  line("");

  for (const b of d.dadosBoleto) {
    line(b.razao, true);
    if (b.cnpj)     mixed("CNPJ/CPF: ",  b.cnpj);
    if (b.boleto)   mixed("Boleto: ",    b.boleto);
    if (b.contrato) mixed("Contrato: ",  b.contrato);
    if (b.valor)    mixed("Valor: ",     b.valor);
    line("");
  }

  y -= LS * 2;
  page.drawLine({ start: { x: ML, y: y + LS * 0.3 }, end: { x: ML + 280, y: y + LS * 0.3 }, thickness: 0.5, color: K });
  y -= LS * 0.5;
  mixed("EMITENTE: ",    d.nomeCliente);
  mixed("CNPJ / CPF: ", d.cpf);

  return doc.save();
}

function wrap(text, font, size, maxW) {
  const lines = [];
  let cur = "";
  for (const w of text.split(" ")) {
    const c = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(c, size) <= maxW) { cur = c; }
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function san(s) {
  return String(s || "")
    .replace(/[ãâáàä]/g,"a").replace(/[ÃÂÁÀ]/g,"A")
    .replace(/[êéèë]/g,"e").replace(/[ÊÉÈ]/g,"E")
    .replace(/[îíìï]/g,"i").replace(/[ÎÍÌ]/g,"I")
    .replace(/[ôóòõö]/g,"o").replace(/[ÔÓÒÕ]/g,"O")
    .replace(/[ûúùü]/g,"u").replace(/[ÛÚÙ]/g,"U")
    .replace(/ç/g,"c").replace(/Ç/g,"C")
    .replace(/[–—]/g,"-").replace(/[""]/g,'"').replace(/['']/g,"'")
    .replace(/[^\x20-\x7E]/g,"");
}

// ─── Upload e anexo no Pipefy ──────────────────────────────────────────────
async function anexarPdfNoPipefy(cardId, cpf, pdfBytes, token) {
  const fileName = `CARTA_${cpf.replace(/[^\d]/g,"")}.pdf`;

  const pr = await pipefyFetch(`mutation { createPresignedUrl(input: { organizationId: ${ORG_ID}, fileName: "${fileName}" }) { url } }`, token);
  const presignedUrl = pr.data?.createPresignedUrl?.url;
  if (!presignedUrl) throw new Error("Falha ao obter presigned URL");

  const up = await fetch(presignedUrl, { method: "PUT", body: pdfBytes, headers: { "Content-Type": "application/pdf" } });
  if (!up.ok) throw new Error(`Falha no upload: ${up.status}`);

  const filePath = new URL(presignedUrl).pathname.replace(/^\//,"");
  const ar = await pipefyFetch(`mutation { updateCardField(input: { card_id: ${cardId}, field_id: "${FIELD_ID}", new_value: ["${filePath}"] }) { success } }`, token);
  if (!ar.data?.updateCardField?.success) throw new Error("Falha ao anexar PDF");
}

async function pipefyFetch(query, token) {
  const res  = await fetch(PIPEFY_API, { method:"POST", headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"}, body:JSON.stringify({query}) });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

function parseData(s) {
  if (!s) return null;
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(s+"T12:00:00");
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [dd,mm,yy]=s.split("/"); d=new Date(`${yy}-${mm}-${dd}T12:00:00`); }
  else d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatarDataPortugues(s) {
  const M=["Janeiro","Fevereiro","Marco","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const d=parseData(s); if(!d) return s||"";
  return `${d.getDate()} de ${M[d.getMonth()]} de ${d.getFullYear()}`;
}

function formatarDataDDMMYYYY(s) {
  if(!s) return "";
  if(/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const d=parseData(s); if(!d) return s;
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), { status, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} });
}

function cors() {
  return new Response(null, { headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, X-Worker-Secret"} });
}
