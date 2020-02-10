import { EntityManager, SelectQueryBuilder } from 'typeorm';
import { SelectQuery } from 'typeorm/query-builder/SelectQuery';
import * as uuid from 'uuid';
import { plainToClass } from 'class-transformer';

declare module 'typeorm' {
  interface EntityManager {
    getOneInTransaction: <Entity, K = keyof Entity>(entity: new () => Entity, uniqueKey: K, query: (queryBuilder: SelectQueryBuilder<Entity>) => SelectQueryBuilder<Entity>, select?: K[]) => Promise<Entity | null>;
  }
}

EntityManager.prototype.getOneInTransaction = async function <Entity, K = keyof Entity>(entity: new () => Entity, uniqueKey: K, query: (queryBuilder: SelectQueryBuilder<Entity>) => SelectQueryBuilder<Entity>, select: K[] = []) {
  const tempAlias = uuid.v4().replace(/-/g, '');
  const baseQueryBuilder = this.createQueryBuilder().select(uniqueKey as any).from(entity, tempAlias) as SelectQueryBuilder<any>;
  const [rawQuery, params] = query(baseQueryBuilder).limit(1).getQueryAndParameters();

  const queryBuilder = this.createQueryBuilder();
  const escape = (name: any) => queryBuilder.escape(name);

  let realQuery = rawQuery.replace(escape(tempAlias), '');
  const realParams = {} as { [key: string]: any };

  const paramRegex = /(?<key>\$(?<index>[0-9]+))/g;
  let paramMatches: RegExpExecArray | null;
  while ((paramMatches = paramRegex.exec(rawQuery)) !== null) {
    const key = paramMatches.groups?.key;
    const index = paramMatches.groups?.index;
    if (!key || typeof index !== 'string') {
      continue;
    }
    const indexNumber = Number(index);

    realQuery = realQuery.replace(key, `:param${indexNumber}`);
    realParams[`param${indexNumber}`] = params[indexNumber - 1];
  }

  const completedQuery = queryBuilder
    .update(entity, {})
    .where(`
      ${escape(uniqueKey)} = (
        ${realQuery}
        FOR UPDATE SKIP LOCKED
      )
    `, realParams)
    .returning(select.length === 0 ? '*' : select as any[]);

  const executeResult = await completedQuery.execute();
  if (!executeResult || (executeResult.raw ?? []).length === 0) {
    return null;
  }

  return plainToClass(entity, executeResult.raw[0]);
};
