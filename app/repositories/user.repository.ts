import { User } from './../entities/user.entity';
import { EntityRepository, Repository } from 'typeorm';

@EntityRepository()
export class UserRepository extends Repository<User> {
  public async getOrCreate(id: string, props: Pick<User, 'name' | 'username'>) {
    try {
      return await this.findOneOrFail(id);
    } catch {
    }

    const created = this.create({
      id,
      ...props,
    });
    await this.save(created);

    return created;
  }
}
