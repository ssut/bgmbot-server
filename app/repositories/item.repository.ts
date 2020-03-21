import { Item } from './../entities/item.entity';
import { EntityRepository, Repository } from 'typeorm';
import { generateQueryRegexCondition } from '../utils/hangul';

const SKIP_KEYWORDS = [
  '가사',
  '첨부',
];

@EntityRepository()
export class ItemRepository extends Repository<Item> {
  public async getAutoCompletionTitles(keyword: string, limit = 10) {
    const titleConditions = keyword.split(/\s/g).map((k) => generateQueryRegexCondition(k));

    if (titleConditions.length === 0) {
      return [];
    }

    const query = this.createQueryBuilder().select('title');

    for (const [i, titleCondition] of Object.entries(titleConditions)) {
      query.andWhere(`title ~* :title${i}`, { [`title${i}`]: titleCondition });
    }

    const results = await query.limit(limit).execute();
    const titles = (results ?? []).map(({ title }: { title: string }) => title) as string[];

    const items = titles.map((title) => {
      const completions = [] as string[];

      for (const titleRegex of titleConditions) {
        const regex = new RegExp(titleRegex, 'ig');
        const execResult = regex.exec(title);
        if (execResult === null) {
          return null;
        }

        const { index } = execResult;
        let shouldStop = false;
        const completion = title.split(/(?:)/).reduce((accum, current, currentIndex) => { // 스페이스로 자르고
          if (shouldStop) { // 멈추는 조건이면 그만
            return accum;
          } else if (currentIndex < index) { // 일단 시작 인덱스까지는 이 조건
            const currentToEnd = title.substring(currentIndex, index);
            if (/[^a-z가-힣]/ig.test(currentToEnd)) { // 영단어 또는 한글단어가 안 붙어 있으면
              return accum; // 스킵
            }

            return accum + current;  // 아니면 붙여주기
          }

          if (/[^a-z가-힣 ]/ig.test(current)) {
            shouldStop = true;
            return accum;
          }

          // 스페이스 제외 마지막 글자 언어가 현재 언어랑 다르면 stop
          const trimmed = accum.trim();
          if (trimmed.length > 0 && trimmed[trimmed.length - 1]) {
            const lastLang = /[가-힣]/.test(trimmed[trimmed.length - 1]) ? 'ko' : 'en';
            const currentLang = /[가-힣]/.test(current) ? 'ko' : 'en';

            if (lastLang !== currentLang) {
              shouldStop = true;
              return accum;
            }
          }

          return accum + current;
        }, '');

        completions.push(completion);
      }

      if (completions.length > 0) {
        return [...new Set(completions.map(x => x.replace(/ {1,}/g, ' ').trim()))].join(' ').trim();
      }

      return null;
    });

    return [...new Set(items)]
      .filter(x => x !== null && !SKIP_KEYWORDS.includes(x))
      .map((x) => ({ result: x, length: x!.length, diff: x!.length - keyword.length }))
      .sort((a, b) => a.diff - b.diff)
      .map(({ result }) => result);
  }
}
