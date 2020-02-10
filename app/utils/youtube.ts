import axios, { AxiosInstance } from 'axios';
import axiosCookieJarSupport from 'axios-cookiejar-support';
import toughCookie from 'tough-cookie';
import cheerio from 'cheerio';
import qs from 'qs';
import vm from 'vm';

axiosCookieJarSupport(axios);

const vmContext = vm.createContext({
  google: {
    sbox: {
      p50: (result: any) => result,
    },
  },
});

export class YouTube {
  private client: AxiosInstance;
  private jar = new toughCookie.CookieJar();
  private isSessionSet = false;

  private tokens = {
    psuggestion: '',
    id: '',
    xsrf: '',
  };

  private sboxSettings = Object.freeze({
    REQUEST_LANGUAGE: 'en',
    REQUEST_DOMAIN: 'kr',
    SEND_VISITOR_DATA: false,
  });

  public constructor() {
    this.client = axios.create({
      jar: this.jar,
      withCredentials: true,
      headers: {
        'sec-ch-ua': 'Google Chrome 80',
        'sec-fetch-site': 'none',
        'sec-origin-policy': '0',
        'upgrade-insecure-requests': '0',
        'user-agent': 'Mozilla/5.0 (iPad; CPU OS 11_0 like Mac OS X) AppleWebKit/604.1.34 (KHTML, like Gecko) Version/11.0 Mobile/15A5341f Safari/604.1',
      },
    });
  }

  private extractToken(content: string, tokenName: string) {
    const regex = new RegExp(`"${tokenName}":"(?<token>[a-z0-9=]+)"`, 'ig');

    const execResult = regex.exec(content);
    if (!execResult) {
      return null;
    }

    const token = execResult.groups?.['token'] ?? null;
    return token;
  }

  private async ensureSession() {
    if (this.isSessionSet) {
      return;
    }

    const resp = await this.client.get('https://m.youtube.com/?app=m&persist_app=1');
    const body = resp.data;

    this.tokens.psuggestion = this.extractToken(body, 'PSUGGEST_TOKEN') ?? '';
    this.tokens.id = this.extractToken(body, 'ID_TOKEN') ?? '';
    this.tokens.xsrf = this.extractToken(body, 'XSRF_TOKEN') ?? '';
    this.isSessionSet = true;
  }

  // ?
  private generateGSGBG() {
    let a = '';
    for (var f = 4 + Math.floor(32 * Math.random()), g = 0, h; g < f; ++g) {
      h = .3 > Math.random() ? 48 + Math.floor(10 * Math.random()) : (.5 < Math.random() ? 65 : 97) + Math.floor(26 * Math.random());
      a += String.fromCharCode(h);
    }

    return a;
  }

  public async getSuggestionsByKeyword(keyword: string) {
    await this.ensureSession();

    const query = qs.stringify({
      client: 'youtube-reduced',
      hl: 'ko',
      gs_ri: 'youtube-reduced',
      tok: this.tokens.psuggestion,
      ds: 'yt',
      cp: 1,
      gs_id: 6,
      q: keyword,
      callback: 'google.sbox.p50',
      gs_gbg: this.generateGSGBG(),
    });
    const resp = await this.client.get('https://clients1.google.com/complete/search?' + query, {
      headers: {
        referer: 'https://m.youtube.com/?app=m&persist_app=1',
      },
    });
    const data = resp.data;
    const result = vm.runInContext(`(() => { return ${data}; })()`, vmContext);
    const [
      requestedKeyword,
      suggestions,
      meta,
    ] = result as [string, [
        string,
        number,
        [number],
    ][], { a: string; j: string; k: number; q: string }];

    return suggestions.map((suggestion) => ({
      suggestion: suggestion?.[0] ?? '',
      score: suggestion?.[2]?.[0] ?? 0,
    })).filter(({ suggestion }) => suggestion !== '');
  }
}
