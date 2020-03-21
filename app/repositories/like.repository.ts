import { Like } from '../entities/like.entity';
import { EntityRepository, Repository } from 'typeorm';

@EntityRepository()
export class LikeRepository extends Repository<Like> {

}
