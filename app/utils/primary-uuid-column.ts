import { ColumnOptions, getMetadataArgsStorage, Generated } from 'typeorm';
import { PrimaryGeneratedColumnUUIDOptions } from 'typeorm/decorator/options/PrimaryGeneratedColumnUUIDOptions';
import { ColumnMetadataArgs } from 'typeorm/metadata-args/ColumnMetadataArgs';
import { GeneratedMetadataArgs } from 'typeorm/metadata-args/GeneratedMetadataArgs';

export function PrimaryUUIDColumn(options: ColumnOptions = {}): Function {
  return (object: Object, propertyName: string) => {
    // eslint-disable-next-line no-param-reassign
    options.type = 'uuid';
    // eslint-disable-next-line no-param-reassign
    options.primary = true;
    // eslint-disable-next-line no-param-reassign
    options.default = () => 'uuid_generate_v4()';

    // register column metadata args
    getMetadataArgsStorage().columns.push({
      target: object.constructor,
      propertyName,
      mode: 'regular',
      options,
    });

    // register generated metadata args
    getMetadataArgsStorage().generations.push({
      target: object.constructor,
      propertyName,
      strategy: 'uuid',
    } as GeneratedMetadataArgs);
  };
}
