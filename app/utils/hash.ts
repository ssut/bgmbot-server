import crypto from 'crypto';

export const sha512 = (text: string) => crypto.createHash('sha512').update(text).digest().toString('hex');
