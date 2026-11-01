/**
 * 各源语言的对白引语动词。
 * 无引号对白只有这一个低成本信号，缺词会静默漏判对白段（不报错，只降低召回）。
 */
export const SPEECH_VERBS_BY_LANGUAGE: Record<string, RegExp> = {
  en: /\b(said|asked|replied|answered|whispered|shouted|murmured|called|cried|snapped|remarked|wondered|added|insisted|began|continued|laughed|sighed|told)\b/iu,
  fr: /(?<![\p{L}])(?:dit|demanda|répondit|répliqua|murmura|chuchota|cria|s'écria|ajouta|poursuivit|continua|insista|soupira|raconta)(?![\p{L}])/iu,
  de: /(?<![\p{L}])(?:sagte|fragte|antwortete|erwiderte|flüsterte|rief|schrie|murmelte|meinte|fügte|erklärte|lachte|seufzte|erzählte)(?![\p{L}])/iu,
  it: /(?<![\p{L}])(?:disse|chiese|rispose|sussurrò|urlò|gridò|mormorò|esclamò|aggiunse|continuò|insistette|sospirò|raccontò|replicò)(?![\p{L}])/iu,
  es: /(?<![\p{L}])(?:dijo|dijeron|preguntó|pregunto|preguntaron|respondió|respondio|respondieron|replicó|replico|susurró|susurro|gritó|grito|murmuró|murmuro|exclamó|exclamo|añadió|anadio|continuó|continuo|insistió|insistio|suspiró|suspiro|contó|conto|explicó|explico|comentó|comento|contestó|contesto)(?![\p{L}])/iu,
  ja: /(?:言った|尋ねた|答えた|話した|叫んだ|囁いた|つぶやいた|聞いた|続けた|返した|問いかけた|説明した)/u,
};
