import { Entity, PrimaryGeneratedColumn, Index, Column } from 'typeorm';

export enum ConfigKey {
  SlackClientId = 'slack.client.id',
  SlackClientSecret = 'slack.client.secret',
  SlackBotUserAccessToken = 'slack.bot-user.access-token',
  SlackBotUserId = 'slack.bot-user.id',

  YouTubeKeys = 'youtube.keys',
  Channels = 'channels',
}

@Entity()
export class Config {
  @PrimaryGeneratedColumn()
  public id!: number;

  @Index({ unique: true })
  @Column()
  public key!: string;

  @Column({ type: 'jsonb' })
  public value!: any;
}
