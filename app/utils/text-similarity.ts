/*
 * Return mutual elements in the input sets
 */
const intersection = (a: string[], b: string[]) => [...new Set(a.filter(x => b.indexOf(x)))];

/*
 * Return distinct elements from both input sets
 */
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/*
 * Similarity
 */
const index = (a: string[], b: string[]) => intersection(a, b).length / union(a, b).length;

/**
 * Normalization
 */
const normalize = (str: string) => {
  let normalized = str.replace(/('|"|\!|\?|\-)/g, '').replace(/\s+/g, ' ');

  const prefix = /^(\[|\()([a-zA-Z가-힣-_.]+)(\]|\))/.exec(normalized);
  if (prefix && prefix.length > 0) {
    const match = prefix[0];
    if (match) {
      normalized = normalized.replace(match, '').trim();
    }
  }

  return normalized;
};

/**
 * Tokenize
 */
const tokenizer = (document: string) => {
  return document.split(/\s+/g);
};

export const calculateSimilarity = (a: string, b: string) => {
  const x = tokenizer(normalize(a));
  const y = tokenizer(normalize(b));

  return index(x, y);
};
