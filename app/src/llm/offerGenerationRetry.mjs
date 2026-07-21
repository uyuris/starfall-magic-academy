// Bounded retry for weekly offer text generation (研究会・依頼共通の1箇所).
//
// 週次オファーの文面は LLM 生成で、その出力は確率的にゲート（引用符・鉤括弧・改行の禁止／
// { title, situation, motivation, appeal } の shape／長さ上限）を破ることがある。prompt は
// すでに記号禁止を明記しており、prompt 強化だけでは構造的に防げない。そこで同一 skeleton の
// まま bounded 回数だけ文面を再生成し、gate-clean な出力が出た最初のものを採用する。
//
// retry するのは「生成出力の検証失敗」だけ。gate/validate 違反は該当ドメインの generation
// error code（STUDY_CIRCLE_GENERATION_FAILED / ERRAND_GENERATION_FAILED）で識別する。LM の
// 設定不備・接続不能・HTTP エラー・JSON parse 失敗は別クラスの失敗なので retry せず即座に
// throw する（fail-fast）。全試行が gate 違反なら最後の gate error をそのまま throw し、上位は
// 現行どおり構造化 503 で fail-fast する。silent な記号除去・自動置換・fallback 文面は入れない。

// Tunable retry cap, shared by study circle and errand offer generation. Counts total attempts
// per offer (1 = no retry). 3 attempts/offer は確率事象を実用上ほぼ吸収しつつ暴走を防ぐ上限。
export const OFFER_GENERATION_MAX_ATTEMPTS = 3;

// Generates one offer's text and gates it, retrying ONLY on a generation gate/validate
// violation (identified by generationErrorCode). `generate()` produces a candidate (the real
// 2-call LLM generation or a test mock); `validate(candidate)` is the authoritative gate that
// returns the trimmed fields or throws the generation error. Any error whose errorCode is not
// generationErrorCode (LM 設定不備・接続不能・HTTP・parse) is rethrown immediately without a
// retry. When every attempt is a gate violation, the last gate error is rethrown.
export async function generateGatedOfferTextWithRetry({ generate, validate, generationErrorCode } = {}) {
  if (typeof generate !== 'function') throw new Error('generate is required');
  if (typeof validate !== 'function') throw new Error('validate is required');
  if (!generationErrorCode) throw new Error('generationErrorCode is required');
  let lastGateError;
  for (let attempt = 1; attempt <= OFFER_GENERATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return validate(await generate());
    } catch (error) {
      // A non-gate failure is a different failure class (LM unconfigured/unreachable, HTTP,
      // parse) — fail fast, do not spend the retry budget on it.
      if (error?.errorCode !== generationErrorCode) throw error;
      lastGateError = error;
    }
  }
  throw lastGateError;
}
