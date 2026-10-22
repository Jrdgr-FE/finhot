// analyzeArticle: the judging and writing steps, each with its own prompt from the industry pack
// (industry/prompts/):
//   1. prefilter: does the material belong to this industry at all (wide recall). Only BLOCK stops an
//      item; UNKNOWN goes on like PASS (a BLOCK given while material is missing counts as UNKNOWN);
//   2. score: scores against the source tier's threshold (industry/selection.ts) decide 精选: one score when it
//      is clearly above or below, a second independent one near the threshold (their mean decides);
//      the item's primary domain (industry/domains.ts) picks the score prompt, the threshold, the
//      content understanding prompt, the categories and the tag vocabulary;
//   3. writing: the Chinese title, summary and reason by the content understanding for selected and
//      near-selected items, by the cheaper title/summary prompts for the rest;
//   4. structure (no reader-facing text): category, tags, subject companies and the fact frame the
//      topics and the event grouping need; it runs beside the scoring.
// Material with only a title or a feed summary has its article page fetched before it is judged.
import { z } from "zod";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { VOCABULARY } from "@aihot/industry/taxonomy";
import { basicCategory, categoryDomain } from "@aihot/industry/classification";
import { basicDomains, DEFAULT_DOMAIN, domainDef, domainThreshold, isDomainKey, sourceDomains, type DomainKey } from "@aihot/industry/domains";
import { SELECTION } from "@aihot/industry/selection";
import { sql } from "../db.ts";
import { chatJson, MODELS, type ContentPart } from "../providers/llm.ts";
import { completeReceipt, ProviderRejectedError } from "../providers/receipts.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { modelFor } from "./models.ts";
import { buildMaterial, firstImagePart, loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";
import { pageFetchable } from "../content/extract.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, finalizeCopy, isShortTweetInput, looksZh, MAX_BODY_CHARS, missingEvidence,
  needsShortTweetTranslation, parseTranslateOutput, PREFILTER_SYSTEM, prefilterUser, translateInputOf, understandSystem, understandUser,
  type IdentityGuard,
} from "./writing.ts";
import { categoryGuide, DOMAIN_CATEGORY_GUIDE, DOMAIN_GUIDE, domainCategories, ENTITIES, entityGuide, ITEM_TYPES, normalizeTags } from "./vocabulary.ts";
import { promptText, promptVersion } from "./prompts.ts";

export { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle };

export const PROMPT_VERSIONS = {
  prefilter: promptVersion("prefilter"),
  score: promptVersion("selection-score"),
  understand: promptVersion("understand"),
  summarize: promptVersion("summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted", "identity-context"),
  structure: promptVersion("structure"),
} as const;
/** Every step's prompt, as stored on each judgement (finance; see analyzePromptVersion). */
export const ANALYZE_PROMPT_VERSION = Object.values(PROMPT_VERSIONS).join("+");

/** One value per domain, computed on first use. */
function perDomain<T>(make: (domain: DomainKey) => T): (domain: DomainKey) => T {
  const made = new Map<DomainKey, T>();
  return (domain) => {
    if (!made.has(domain)) made.set(domain, make(domain));
    return made.get(domain)!;
  };
}

/** The step prompts a domain uses: its own score and understanding prompts, the shared rest. */
export const domainPromptVersions = perDomain((domain) => {
  const d = domainDef(domain);
  return { ...PROMPT_VERSIONS, score: promptVersion(d.prompts.score), understand: promptVersion(d.prompts.understand) };
});
export const analyzePromptVersion = perDomain((domain) => Object.values(domainPromptVersions(domain)).join("+"));

// ── Scoring ───────────────────────────────────────────────────────────────────────────────

/** Independent score calls per article at most; their mean decides and (floored) is shown. */
export const SCORE_CALLS = 2;
/** A first score further than this from the threshold decides alone; nearer, a second one is asked. */
export const SECOND_SCORE_MARGIN = SELECTION.secondScoreMargin;

/**
 * The thresholds on the mean score, per primary domain and source tier (industry/selection.ts): selected
 * when the mean of the scores >= threshold. Tiers without a threshold are not scored for 精选.
 */
export function tierThreshold(tier: string, domain: DomainKey = DEFAULT_DOMAIN): number | null {
  return domainThreshold(domain, tier);
}

/** Unselected items above this mean are written like selected ones. */
export const UNDERSTAND_FLOOR = SELECTION.understandFloor;

/**
 * Call parameters per score model. The GLM scorer runs at temperature 1 with high reasoning (the model
 * registry adds top_p and thinking) and up to 180 s per call.
 */
const SCORE_CALL: Record<string, { temperature: number; maxTokens: number; timeoutMs: number }> = {
  "glm-5.3-flash-selection": { temperature: 1, maxTokens: 65_536, timeoutMs: 180_000 },
};
const scoreCall = (model: string) => SCORE_CALL[model] ?? { temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000 };

/** The score prompt of a domain: its taste (industry/prompts/selection-score*.md). */
export const scoreSystem = perDomain((domain) => promptText(domainDef(domain).prompts.score));
/** The finance score prompt (the prompt before domains). */
export const SCORE_SYSTEM = scoreSystem(DEFAULT_DOMAIN);

export const ScoreSchema = z.object({ attentionScore: z.coerce.number().int().min(0).max(100) });

const SCORE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** The score input's time: Beijing time, ISO 8601 with +08:00 (the form the prompt was tuned on). */
export function scoreInputTime(at: Date): string {
  const ms = at.getTime() % 1000;
  return `${SCORE_TIME.format(at).replace(" ", "T")}${ms ? `.${String(ms).padStart(3, "0")}` : ""}+08:00`;
}

/**
 * The score input: no source facts (the prompt forbids guessing them), the publication time, the
 * original title (items are scored before any Chinese copy exists) and the whole body.
 */
export function buildScoreInput(a: AnalyzeInputArticle): string {
  let body: string;
  if (a.xPost) {
    const quoted = a.xPost.quoted?.text ? `\n\n[引用 ${a.xPost.quoted.handle ? `@${a.xPost.quoted.handle}` : "原推文"}]：${a.xPost.quoted.text}` : "";
    body = `${String(a.xPost.text ?? "").trim()}${quoted}`.trim();
  } else {
    body = (a.bodyText ?? a.excerpt ?? "").trim();
  }
  if (!body) body = a.title;
  const at = a.publishedAt ?? a.discoveredAt ?? null;
  return [
    "请按系统规则评估以下单篇材料所代表的事件。只输出 attentionScore。",
    `【发布时间（北京时间）】\n${at ? scoreInputTime(at) : ""}`,
    `【标题】\n${a.title.trim()}`,
    `【${a.materialScope || (!a.xPost && (!a.bodyText || a.bodyStatus==='unconfirmed')) || body.length>MAX_BODY_CHARS ? '材料片段' : '完整正文'}】\n${body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body}`,
    ...(a.materialScope?[`【材料范围】${a.materialScope}；不能据此宣称通读完整报告。`]:[]),
  ].join("\n\n");
}

// ── Step outputs ──────────────────────────────────────────────────────────────────────────

const PrefilterSchema = z.object({
  label: z.preprocess((v) => String(v ?? "").trim().toUpperCase(), z.enum(["PASS", "BLOCK", "UNKNOWN"])),
  reason: z.string().max(200).catch(""),
});

const FactSchema = z
  .object({
    title: z.string().max(80),
    subject: z.string().max(80).nullable().optional(),
    action: z.string().max(80).nullable().optional(),
    object: z.string().max(160).nullable().optional(),
    occurredAt: z.string().nullable().optional(),
  })
  .nullable()
  .catch(null);

const StructureSchema = z.object({
  category: z.enum(CATEGORY_KEYS).nullable().catch(null),
  tags: z.array(z.string()).max(12).catch([]),
  subjects: z.array(z.string()).max(6).catch([]),
  fact: FactSchema,
});

const UnderstandSchema = z.object({
  itemType: z.enum(ITEM_TYPES),
  authorRole: z.enum(["principal", "observer", "relayer"]).catch("relayer"),
  tags: z.array(z.string()).max(12).catch([]),
  editorialJudgment: z.string().max(400).catch(""),
  titleZh: z.string().trim().min(1).max(200),
  summaryZh: z.string().trim().min(1).max(4000),
});

const SummarizeSchema = z.object({ titleZh: z.string(), summaryZh: z.string(), bodyZh: z.string() });
// `domains` (ranked, the first is the primary domain) replaces `relevant`: none means not relevant.
const BriefSchema = z.object({domains:z.array(z.unknown()).max(8).optional().catch(undefined),relevant:z.boolean().optional().catch(undefined),
  titleZh:z.string().max(200),summaryZh:z.string().max(2000),category:z.enum(CATEGORY_KEYS).nullable().catch(null)});
const BRIEF_SYSTEM = promptText('brief-article',{domainGuide:DOMAIN_GUIDE,categoryGuide:DOMAIN_CATEGORY_GUIDE});

const ZH_COUNT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** The structure step's prompt (it writes nothing a reader sees), filled from the domain's vocabulary. */
const structureSystem = perDomain((domain) => {
  const v = VOCABULARY[domain], count = domainCategories(domain).length;
  return promptText("structure", {
    domainName: domainDef(domain).label,
    categoryCount: ZH_COUNT[count] ?? String(count),
    categoryGuide: categoryGuide(domain),
    categoryTags: v.categoryTags.join("、"),
    topicTags: v.topicTags.join("、"),
    entityTags: v.entityTags.join("、"),
    entities: entityGuide(domain),
  });
});

export interface AnalysisRun {
  /** The item's domains, ranked; the first is the primary domain (scoring, threshold, categories). */
  domains: DomainKey[];
  prefilter: { label: "PASS" | "BLOCK" | "UNKNOWN"; reason: string; model: string; receiptId: number; reused: boolean };
  /**
   * The independent score calls and the tier threshold they are held against; absent when the material
   * is not scored. `refused`: the model's content filter declined it, so it is not selected.
   */
  scores: { model: string; threshold: number; values: number[]; receiptIds: number[]; reused: boolean; refused?: boolean } | null;
  /** The reader-facing copy: `understand` (selected, near-selected), `summarize`, `verbatim` (a Chinese short post), `none`. */
  writing: {
    kind: "understand" | "summarize" | "brief" | "verbatim" | "none";
    model: string | null;
    titleZh: string;
    summaryZh: string;
    reasonZh: string | null;
    tags: string[] | null;
    itemType?: string;
    authorRole?: string;
    identityGuard?: IdentityGuard;
    receiptIds: number[];
    reused: boolean;
  } | null;
  structure: { model: string; category: string | null; tags: string[]; subjects: string[]; fact: z.infer<typeof FactSchema>; receiptId: number; reused: boolean } | null;
}

const isContentFilter = (error: unknown) => error instanceof ProviderRejectedError && !error.retryable && /contentFilter|"1301"/.test(error.message);

/** Only a title or a feed summary, and a page to fetch: the article is judged on the page. */
export function waitsForPage(a: AnalyzeInputArticle): boolean {
  return a.bodyStatus === "pending" && !a.bodyText && !a.xPost && pageFetchable(a.url, a.source.kind);
}

type StepOpts = { attemptTag?: string; scoreModel?: string; briefOnly?: boolean; reuseBrief?: boolean };
export class AnalysisInterruptedError extends Error {}

function checkAnalysisRunning() {
  if (shutdownSignal.signal.aborted) throw new AnalysisInterruptedError("worker shutting down between analysis stages");
}

const subjectOf = (a: AnalyzeInputArticle) => `article:${a.id}@${a.revision}`;
const tagged = (attemptTag: string | undefined, step: string) => [attemptTag, step].filter(Boolean).join(":") || undefined;

async function runPrefilter(a: AnalyzeInputArticle, opts: StepOpts): Promise<AnalysisRun["prefilter"]> {
  const model = await modelFor("prefilter");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "prefilter_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.prefilter,
    system: PREFILTER_SYSTEM,
    user: prefilterUser(a),
    schema: PrefilterSchema,
    temperature: 0,
    maxTokens: 512,
    attemptTag: opts.attemptTag,
  });
  // A BLOCK without material to back it counts as UNKNOWN (which goes on).
  const label = res.data.label === "BLOCK" && missingEvidence(a) ? "UNKNOWN" : res.data.label;
  return { label, reason: res.data.reason, model: res.model, receiptId: res.receiptId, reused: res.reused };
}

async function runScores(a: AnalyzeInputArticle, threshold: number, domain: DomainKey, opts: StepOpts): Promise<NonNullable<AnalysisRun["scores"]>> {
  const model = opts.scoreModel ?? (await modelFor("score"));
  const call = scoreCall(model);
  const input = buildScoreInput(a);
  const values: number[] = [];
  const receiptIds: number[] = [];
  let reused = true;
  // One after the other: the second call reuses the provider's cached prompt. It is only asked when
  // the first score is near the threshold; a clear one decides alone.
  for (let i = 0; i < SCORE_CALLS; i++) {
    if (i > 0 && Math.abs(values[0]! - threshold) > SECOND_SCORE_MARGIN) break;
    checkAnalysisRunning();
    try {
      const res = await chatJson({
        model, purpose: "score_article", subject: subjectOf(a), promptVersion: domainPromptVersions(domain).score, system: scoreSystem(domain), user: input,
        schema: ScoreSchema, temperature: call.temperature, maxTokens: call.maxTokens, timeoutMs: call.timeoutMs,
        // Each call is its own paid request; an explicit re-evaluation gets new ones.
        attemptTag: tagged(opts.attemptTag, `score-${i + 1}`),
      });
      values.push(res.data.attentionScore);
      receiptIds.push(res.receiptId);
      reused &&= res.reused;
    } catch (error) {
      // The model's content filter declines the material (Zhipu 1301): not scored, so not selected.
      if (isContentFilter(error)) return { model, threshold, values, receiptIds, reused: false, refused: true };
      throw error;
    }
  }
  return { model, threshold, values, receiptIds, reused };
}

/** The mean of the scores (one, or two near the threshold); null when not scored or refused. */
function scoreMean(scores: AnalysisRun["scores"]): number | null {
  return scores && !scores.refused && scores.values.length ? scores.values.reduce((total, v) => total + v, 0) / scores.values.length : null;
}

async function runStructure(a: AnalyzeInputArticle, domain: DomainKey, opts: StepOpts): Promise<NonNullable<AnalysisRun["structure"]>> {
  const model = await modelFor("structure");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "structure_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.structure,
    system: structureSystem(domain),
    user: buildMaterial(a),
    schema: StructureSchema,
    temperature: 0.2,
    maxTokens: 800,
    attemptTag: tagged(opts.attemptTag, "structure"),
  });
  const subjects = [...new Set(res.data.subjects.map((s) => s.trim().toLowerCase()).filter((s) => s in ENTITIES))];
  // A category of another domain is dropped (publishing falls back to the domain's navigation category).
  const category = categoryDomain(res.data.category) === domain ? res.data.category : null;
  return { model: res.model, category, tags: normalizeTags(res.data.tags, { domain }), subjects, fact: res.data.fact, receiptId: res.receiptId, reused: res.reused };
}

/** The content understanding; null when the model's content filter declines the material. */
async function runUnderstand(a: AnalyzeInputArticle, domain: DomainKey, opts: StepOpts): Promise<AnalysisRun["writing"]> {
  const model = await modelFor("understand");
  const text = understandUser(a);
  const call = (image: ContentPart | null) => {
    checkAnalysisRunning();
    return chatJson({
      model, purpose: "understand_article", subject: subjectOf(a), promptVersion: domainPromptVersions(domain).understand, system: understandSystem(domain),
      user: image ? [{ type: "text", text }, image] : text, schema: UnderstandSchema, temperature: 0.2, maxTokens: 16_384,
      timeoutMs: 180_000, attemptTag: tagged(opts.attemptTag, "understand"),
    });
  };
  // A model that is known not to read images gets the text only.
  const image = MODELS[model]?.vision === false ? null : await firstImagePart(a);
  let res: Awaited<ReturnType<typeof call>>;
  try {
    res = await call(image);
  } catch (error) {
    if (isContentFilter(error)) return null;
    // The model refused the image (download, format): the text is written without it.
    if (!image || !(error instanceof ProviderRejectedError) || error.retryable) throw error;
    try {
      res = await call(null);
    } catch (retryError) {
      if (isContentFilter(retryError)) return null;
      throw retryError;
    }
  }
  const d = res.data;
  const copy = finalizeCopy(translateInputOf(a), { titleZh: d.titleZh, summaryZh: d.summaryZh });
  return {
    kind: "understand", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: d.editorialJudgment.trim() || null,
    tags: normalizeTags(d.tags, { domain, fallbackCategory: VOCABULARY[domain].categoryByItemType[d.itemType] }), itemType: d.itemType, authorRole: d.authorRole,
    identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused,
  };
}

/** The title/summary prompts (articles, long and short posts). */
async function runSummarize(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  const t = translateInputOf(a);
  const isX = t.sourceKind === "x_search";
  const short = isShortTweetInput(t);
  const main = collapseWhitespace(t.mainText || t.title);
  const plain = { reasonZh: null, tags: null, receiptIds: [] as number[], reused: true };
  // A short post already in Chinese is its own copy, and too little text is not written up from a title.
  if (short && !needsShortTweetTranslation(main)) return { kind: "verbatim", model: null, titleZh: main, summaryZh: main, ...plain };
  if (!short && t.text.trim().length < 20) return { kind: "none", model: null, titleZh: looksZh(t.title) ? t.title : "", summaryZh: "", ...plain };
  const model = await modelFor("summarize");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "summarize_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.summarize,
    system: "",
    user: short ? buildShortTweetPrompt(t) : isX ? buildLongTweetPrompt(t) : buildArticlePrompt(t),
    schema: SummarizeSchema,
    json: false,
    parse: parseTranslateOutput,
    temperature: 0.2,
    maxTokens: 2048,
    attemptTag: tagged(opts.attemptTag, "summarize"),
  });
  const p = res.data;
  const draft = short
    ? { titleZh: p.titleZh || (looksZh(main) ? main : ""), summaryZh: p.bodyZh || p.summaryZh }
    : isX
      ? { titleZh: p.titleZh, summaryZh: p.summaryZh || p.bodyZh }
      : { titleZh: p.titleZh || (looksZh(t.title) ? t.title : ""), summaryZh: p.summaryZh };
  const copy = finalizeCopy(t, draft);
  return { kind: "summarize", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: null, tags: null, identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused };
}

/** Ordinary summaries have no attention score. The selected set still requires the original two scores. */
async function runBrief(a:AnalyzeInputArticle,opts:StepOpts):Promise<AnalysisRun> {
  checkAnalysisRunning();
  const material=(a.bodyText||a.excerpt||a.xPost?.text||'').trim();
  if(material.length<50)return {domains:basicDomains(a.sourceId??'',a.title),prefilter:{label:'UNKNOWN',reason:'材料不足',model:'rule',receiptId:0,reused:true},scores:null,
    writing:{kind:'none',model:null,titleZh:a.title,summaryZh:'',reasonZh:null,tags:null,receiptIds:[],reused:true},structure:null};
  const model=await modelFor('summarize');
  const res=await chatJson({model,purpose:'brief_article',subject:subjectOf(a),promptVersion:promptVersion('brief-article'),
    system:BRIEF_SYSTEM,user:buildMaterial(a),schema:BriefSchema,temperature:0.2,maxTokens:900,attemptTag:tagged(opts.attemptTag,'brief')});
  const copy=finalizeCopy(translateInputOf(a),{titleZh:res.data.titleZh,summaryZh:res.data.summaryZh});
  // The model's domains when it gave them (none: not relevant); an answer without them falls back to `relevant`.
  const listed=res.data.domains?[...new Set(res.data.domains.map(d=>String(d??'').trim().toLowerCase()).filter(isDomainKey))]:null;
  const relevant=listed?listed.length>0:res.data.relevant===true;
  // The source's own domain leads when the model lists it: an outlet's items are judged by its domain's
  // standard, and the other domains it names are added (a finance outlet's chip story: finance, then ai).
  const lead=listed?.find(d=>sourceDomains(a.sourceId??'').includes(d));
  const domains=listed?.length?(lead?[lead,...listed.filter(d=>d!==lead)]:listed):basicDomains(a.sourceId??'',a.title),primary=domains[0]!;
  const category=categoryDomain(res.data.category)===primary?res.data.category!:basicCategory(a.sourceId??'',a.title,null,primary);
  return {domains,prefilter:{label:relevant?'PASS':'BLOCK',reason:'普通摘要相关性判断',model:res.model,receiptId:res.receiptId,reused:res.reused},scores:null,
    writing:{kind:'brief',model:res.model,titleZh:copy.titleZh,summaryZh:relevant?copy.summaryZh:'',reasonZh:null,tags:null,
      identityGuard:copy.identityGuard,receiptIds:[res.receiptId],reused:res.reused},
    structure:{model:res.model,category,tags:[],subjects:[],fact:null,receiptId:res.receiptId,reused:res.reused}};
}

async function storedBrief(a:AnalyzeInputArticle):Promise<AnalysisRun|null> {
  const [row]=await sql`SELECT model,title_zh,summary_zh,category,receipt_ids,domains FROM analyses
    WHERE article_id=${a.id} AND input_revision=${a.revision} AND relevance='pass' AND output->>'writer'='brief'
    ORDER BY id DESC LIMIT 1`;
  if(!row?.summary_zh||!row.receipt_ids?.length)return null;
  const receiptId=row.receipt_ids[0];
  const stored=((row.domains??[]) as unknown[]).filter(isDomainKey);
  return {domains:stored.length?stored:basicDomains(a.sourceId??'',a.title),prefilter:{label:'PASS',reason:'复用普通摘要相关性判断',model:row.model,receiptId,reused:true},scores:null,
    writing:{kind:'brief',model:row.model,titleZh:row.title_zh,summaryZh:row.summary_zh,reasonZh:null,tags:null,receiptIds:row.receipt_ids,reused:true},
    structure:{model:row.model,category:row.category,tags:[],subjects:[],fact:null,receiptId,reused:true}};
}

/**
 * Runs the steps on the material as it is (or reuses their receipts) without writing business results.
 * `stages: "selection"` stops after the scores (SelectBench).
 */
export async function runAnalysis(a: AnalyzeInputArticle, opts: StepOpts & { stages?: "selection" | "all" } = {}): Promise<AnalysisRun> {
  checkAnalysisRunning();
  if(opts.briefOnly)return runBrief(a,opts);
  const brief=opts.reuseBrief?await storedBrief(a):null;
  if(brief){
    // Scored once, by the primary domain's standard.
    const domain=brief.domains[0]!,threshold=tierThreshold(a.source.tier,domain),scores=threshold===null?null:await runScores(a,threshold,domain,opts);
    const mean=scoreMean(scores),near=mean!==null&&(mean>=scores!.threshold||mean>UNDERSTAND_FLOOR);
    return {...brief,scores,writing:near?(await runUnderstand(a,domain,opts)??brief.writing):brief.writing,
      structure:near?await runStructure(a,domain,opts):brief.structure};
  }
  // The full path has no model domain judgement: the source's domains and the title rule decide.
  const domains = basicDomains(a.sourceId ?? "", a.title), domain = domains[0]!;
  const prefilter = await runPrefilter(a, opts);
  // UNKNOWN is let through (its material is as complete as it will get); BLOCK stops here.
  if (prefilter.label === "BLOCK") return { domains, prefilter, scores: null, writing: null, structure: null };
  const threshold = tierThreshold(a.source.tier, domain);
  if (opts.stages === "selection") {
    const scores = threshold === null ? null : await runScores(a, threshold, domain, opts);
    return { domains, prefilter, scores, writing: null, structure: null };
  }
  // The structure step needs nothing from the scores: it runs beside them.
  const structure = runStructure(a, domain, opts).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const scores = threshold === null ? null : await runScores(a, threshold, domain, opts);
    const mean = scoreMean(scores), near = mean !== null && (mean >= scores!.threshold || mean > UNDERSTAND_FLOOR);
    const writing = (near ? await runUnderstand(a, domain, opts) : null) ?? (await runSummarize(a, opts));
    const s = await structure;
    if ("error" in s) throw s.error;
    return { domains, prefilter, scores, writing, structure: s.value };
  } finally {
    // A score/writing error or deploy must not let the job finish while a paid structure request
    // still owns a response. It settles and stores its receipt before shutdown can close the DB.
    await structure;
  }
}

/** One judgement from the steps: the selection rule, the reader-facing copy and the structure. */
export function normalizeAnalysis(run: AnalysisRun) {
  const label = run.prefilter.label;
  const titleZh = collapseWhitespace(run.writing?.titleZh ?? "");
  const summaryZh = (run.writing?.summaryZh ?? "").trim();
  // Past the prefilter (PASS or UNKNOWN) an item is relevant, but without a usable Chinese title and
  // summary it cannot be published: it waits.
  const relevance = label === "BLOCK" ? "block" : run.writing && (!titleZh || !summaryZh) ? "unknown" : "pass";
  // Selected when the mean of the scores reaches the tier threshold; the mean, floored, is the score
  // shown (it never decides a half point on its own).
  const values = run.scores && !run.scores.refused && run.scores.values.length ? run.scores.values : null;
  const sum = values ? values.reduce((total, v) => total + v, 0) : null;
  const score = sum === null ? null : Math.floor(sum / values!.length);
  const threshold = run.scores?.threshold ?? null;
  const selected = relevance === "pass" && sum !== null && threshold !== null && sum >= threshold * values!.length;
  const subjects = run.structure?.subjects ?? [];
  const tags = [...(run.writing?.tags ?? run.structure?.tags ?? [])];
  for (const s of subjects) {
    const display = ENTITIES[s]?.displayTag;
    if (display && !tags.includes(display)) tags.push(display);
  }
  const domains = run.domains.length ? run.domains : [DEFAULT_DOMAIN];
  return {
    domains,
    primaryDomain: domains[0]!,
    relevance,
    selected,
    score,
    scores: values,
    scoreModel: run.scores?.model ?? null,
    scoreRefused: run.scores?.refused ?? false,
    threshold,
    category: run.structure?.category ?? null,
    tags,
    subjects,
    titleZh,
    summaryZh,
    reasonZh: run.writing?.reasonZh ?? null,
    fact: run.structure?.fact ?? null,
  };
}

export interface AnalyzeResult {
  analysisId: number | null;
  stale: boolean;
  /** The article page is to be fetched first; nothing was committed. */
  needsBody?: boolean;
  output: ReturnType<typeof normalizeAnalysis> | null;
  receiptIds: number[];
  reused: boolean;
}

/**
 * Analyses the current revision and commits the judgement. A result computed for an older revision
 * is kept for traceability but never overwrites a newer input (stale = true).
 */
export async function analyzeArticle(articleId: string, opts: StepOpts = {}): Promise<AnalyzeResult | null> {
  const input = await loadAnalyzeInput(articleId);
  if (!input) return null;
  // Its page first; extraction queues the analysis again (normally the queue already routed it there).
  if (waitsForPage(input)) return { analysisId: null, stale: false, needsBody: true, output: null, receiptIds: [], reused: true };
  const run = await runAnalysis(input, opts);
  const out = normalizeAnalysis(run);
  const receiptIds = [...new Set([
    run.prefilter.receiptId, ...(run.scores?.receiptIds ?? []), ...(run.writing?.receiptIds ?? []), ...(run.structure ? [run.structure.receiptId] : []),
  ].filter(id=>id>0))];
  const w = run.writing;
  const detail = {
    ...(opts.reuseBrief?{reviewed:true}:{}),
    prefilter: { label: run.prefilter.label, reason: run.prefilter.reason },
    scores: out.scores, scoreModel: out.scoreModel, threshold: out.threshold, ...(out.scoreRefused ? { scoreRefused: true } : {}),
    ...(w ? { writer: w.kind, writerModel: w.model, itemType: w.itemType ?? null, authorRole: w.authorRole ?? null } : {}),
    ...(w?.identityGuard?.outcome === "fallback" ? { identityGuard: w.identityGuard } : {}),
    fact: out.fact,
  };
  const committed = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const stale = !current || current.revision !== input.revision;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, tags,
        subjects, title_zh, summary_zh, reason_zh, score, selected, output, domains, primary_domain)
      VALUES (${articleId}, ${input.revision}, 'model', ${w?.model ?? run.prefilter.model}, ${opts.briefOnly?promptVersion('brief-article'):analyzePromptVersion(out.primaryDomain)}, ${receiptIds},
        ${out.relevance}, ${out.category}, ${out.tags}, ${out.subjects}, ${out.titleZh}, ${out.summaryZh}, ${out.reasonZh},
        ${out.score}, ${out.selected}, ${tx.json(detail as never)}, ${out.domains}, ${out.primaryDomain})
      RETURNING id`;
    for (const id of receiptIds) await completeReceipt(tx, id);
    if (!stale) {
      await tx`UPDATE articles SET processing_state = ${out.relevance === "block" ? "blocked" : "analyzed"}, processing_error = NULL WHERE id = ${articleId}`;
    }
    return { analysisId: row!.id, stale };
  });
  const reused = run.prefilter.reused && (run.scores?.reused ?? true) && (w?.reused ?? true) && (run.structure?.reused ?? true);
  return { analysisId: committed.analysisId, stale: committed.stale, output: out, receiptIds, reused };
}
