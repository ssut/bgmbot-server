import { Config } from './../entities/config.entity';
import { EntityRepository, Repository } from 'typeorm';

@EntityRepository()
export class ConfigRepository extends Repository<Config> {

}
