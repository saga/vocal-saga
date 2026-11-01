/**
 * 源语言代码别名与语言判别词表。
 */

/** 语言名称/别名 → BCP-47 主语言子标签。查表时先整串，再取分隔符前的主标签。 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  english:'en',eng:'en',french:'fr',français:'fr',fra:'fr',fre:'fr',
  german:'de',deutsch:'de',deu:'de',ger:'de',italian:'it',italiano:'it',ita:'it',spanish:'es',español:'es',espanol:'es',castellano:'es',spa:'es',
  japanese:'ja',日本語:'ja',jpn:'ja',chinese:'zh',中文:'zh',zho:'zh',
};

/**
 * 源语言未声明时按功能词命中数投票。
 * 键顺序即平票优先级：票数相同且不领先时按 es → fr → de → it 的先后稳定排序。
 */
export const LANGUAGE_DETECTION_WORDS: Record<string, RegExp> = {
  es: /\b(?:el|los|las|una|unos|unas|y|que|con|para|por|pero|porque|del|al|se|es|son|está|están|fue|dijo|ella|ellos|nosotros|usted)\b/gu,
  fr: /\b(?:le|la|les|une|des|est|et|que|qui|avec|dans|pour|pas|mais|je|elle|vous|nous)\b/gu,
  de: /\b(?:der|die|das|ein|eine|und|ist|mit|nicht|ich|war|hat|zu|von|dem|den|er|sie|drei|zwei|vier|fünf)\b/gu,
  it: /\b(?:il|lo|gli|sono|che|non|una|per|con|della|era|dove|ma|voi|noi)\b/gu,
};
