import { PlaylistItem } from './playlist-item.entity';
import { Item } from './item.entity';
import { User } from './user.entity';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToOne, JoinColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity()
export class Like {
  @PrimaryGeneratedColumn()
  public id!: number;

  @Index()
  @Column({ nullable: false })
  public userId!: string;

  @ManyToOne((type) => User, user => user.likes, { cascade: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  public user!: User;

  @Index()
  @Column({ nullable: false, unique: false })
  public itemId!: string;

  @ManyToOne((type) => Item, { cascade: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  public item!: Item;

  @Index()
  @Column({ nullable: false, unique: false })
  public playlistItemId!: number;

  @ManyToOne((type) => PlaylistItem, { cascade: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  public playlistItem!: PlaylistItem;

  @CreateDateColumn()
  public createdAt!: Date;

  @UpdateDateColumn()
  public updatedAt!: Date;
}
