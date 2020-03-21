import { slack } from './../common';
import { PlaylistItem } from './playlist-item.entity';
import { Entity, PrimaryColumn, Column, OneToMany, ManyToOne, CreateDateColumn, UpdateDateColumn, getRepository } from 'typeorm';
import Config from '../config';
import jwt from 'jsonwebtoken';
import { Like } from './like.entity';

@Entity()
export class User {
  @PrimaryColumn()
  public id!: string;

  @Column()
  public username!: string;

  @Column()
  public name!: string;

  @Column({ nullable: true })
  public slackImChannelId!: string;

  @OneToMany(type => PlaylistItem, playlistItem => playlistItem.user)
  public playlistItems!: PlaylistItem[];

  @Column({ type: 'text', array: true, default: '{}' })
  public allowedChannels!: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  public ownedChannels!: string[];

  @Column({ nullable: true, default: null })
  public TOSAgreedAt!: Date;

  @CreateDateColumn()
  public createdAt!: Date;

  @UpdateDateColumn()
  public updatedAt!: Date;

  @OneToMany((type) => Like, like => like.user)
  public likes!: Like[];

  public get readableName() {
    return this.name.split(' ').reverse().join('');
  }

  public async generateAuthToken(additionalPayload: any = {}, expiresIn = '7d') {
    const token = await jwt.sign({
      userId: this.id,
      ...additionalPayload,
    }, Config.Jwt.Secret, {
      expiresIn,
    });

    return token;
  }

  public async ensureSlackImChannel() {
    if (this.slackImChannelId) {
      return;
    }

    const { ims } = await slack.im.list({
      token: Config.Slack.BotUserAccessToken,
    });
    const im = ims.find((x: any) => x.user === this.id);
    if (im) {
      this.slackImChannelId = im.id;
      return;
    }

    const imOpenResult = await slack.im.open({
      token: Config.Slack.BotUserAccessToken,
      user: this.id,
    });

    this.slackImChannelId = imOpenResult.channel.id;
    return getRepository(User).update(this.id, {
      slackImChannelId: this.slackImChannelId,
    });
  }

  public async sendDM(content: any, ephemeral = false) {
    await this.ensureSlackImChannel();

    const fn = ephemeral ? slack.chat.postEphemeral : slack.chat.postMessage;
    return fn({
      token: Config.Slack.BotUserAccessToken,
      channel: this.slackImChannelId,
      ...content,
    });
  }
}
