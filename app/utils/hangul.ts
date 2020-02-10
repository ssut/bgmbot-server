import * as Hangul from 'hangul-js';
import * as _ from 'lodash';

export const getInitSound = (src: string) => {
  const init = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  if (init.includes(src)) {
    return src;
  }

  let iSound = '';
  for (let i = 0; i < src.length; i++) {
    const index = Math.floor(((src.charCodeAt(i) - 44032) / 28) / 21);
    if (index >= 0) {
      iSound += init[index];
    }
  }
  return iSound;
}

export const getMiddleSound = (src: string) => {
  const t = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
  let middle = '';
  for (let i = 0; i < src.length; i++) {
    const index = Math.floor(((src.charCodeAt(i) - 44032) / 28) % 21);
    if (index >= 0) {
      middle += t[index];
    }
  }
  return middle;
}

export const getFinalSound = (src: string) => {
  const t = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  let final = '';
  for (let i = 0; i < src.length; i++) {
    const index = (src.charCodeAt(i) - 44032) % 28;
    if (index >= 0) {
      final += t[index]
    }
  }
  return final;
}

export const getHangulSounds = (src: string) => {
  return {
    ini: getInitSound(src),
    mid: getMiddleSound(src),
    fin: getFinalSound(src),
  }
};

export const isHangulCharacter = (char: string) => /[ㄱ-힣]/.test(char);

export const generateQueryRegexCondition = (str: string) => {
  const chars = str.split(/(?:)/);
  const length = chars.length;

  return chars.reduce((accum, char, index) => {
    const isHangul = isHangulCharacter(char);
    if (!isHangul || index < length - 1) {
      return `${accum}${_.escapeRegExp(char)}`;
    }

    const sounds = getHangulSounds(char);

    if (sounds.fin !== '') {
      // 종성이 있는 경우
      // ex) 한 -> ((한)|(하[ㄴ-힣]))
      return [
        accum,
        `(${char}|(${Hangul.assemble([sounds.ini, sounds.mid])}[${sounds.fin}-힣]))`,
      ].join('');
    } else if (sounds.mid !== '') {
      // 중성이 있는 경우
      // ex) 하 -> (하|([하-핳]))
      return [
        accum,
        `(${char}|([${char}-${Hangul.assemble([sounds.ini, sounds.mid, 'ㅎ'])}]))`,
      ].join('');
    } else if (sounds.ini !== '') {
      // 초성이 있는 경우
      // ex -> ㅎ -> (ㅎ|[ㅎ-힣])
      return [
        accum,
        `(${char}|([${sounds.ini}-힣]))`,
      ].join('');
    }

    return `${accum}${_.escapeRegExp(char)}`;
  }, '');
};
