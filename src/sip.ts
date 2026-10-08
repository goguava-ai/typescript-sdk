// Characters allowed unescaped in each component beyond RFC 3261's `unreserved`,
// which encodeURIComponent already leaves alone. See RFC 3261 section 25.1.
const USER_SAFE = "&=+$,;?/";
const PARAM_SAFE = "[]/:&+$";
const HEADER_SAFE = "[]/?:+$";

function sipEscape(value: string, safe: string): string {
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (escaped) => {
    // Not decodeURIComponent, which throws on single bytes of multibyte UTF-8 sequences.
    const char = String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    return safe.includes(char) ? char : escaped;
  });
}

export class SipUri {
  host: string;
  user?: string;
  /** A `null` value renders as a valueless param, e.g. `;lr`. */
  uriParams: Record<string, string | null>;
  /** A `null` value renders as a valueless header, e.g. `?X-Foo=`. */
  headers: Record<string, string | null>;

  constructor(args: {
    host: string;
    user?: string;
    uriParams?: Record<string, string | null>;
    headers?: Record<string, string | null>;
  }) {
    this.host = args.host;
    this.user = args.user;
    this.uriParams = args.uriParams ?? {};
    this.headers = args.headers ?? {};
  }

  toString(): string {
    let url = "sip:";
    if (this.user !== undefined) {
      url += `${sipEscape(this.user, USER_SAFE)}@`;
    }
    url += this.host;

    for (const [name, value] of Object.entries(this.uriParams)) {
      url += `;${sipEscape(name, PARAM_SAFE)}`;
      if (value !== null) {
        url += `=${sipEscape(value, PARAM_SAFE)}`;
      }
    }

    // Headers always need an "=", so a null value renders as "name=".
    const headers = Object.entries(this.headers);
    if (headers.length > 0) {
      url += `?${headers
        .map(
          ([name, value]) =>
            `${sipEscape(name, HEADER_SAFE)}=${sipEscape(value === null ? "" : String(value), HEADER_SAFE)}`,
        )
        .join("&")}`;
    }

    return url;
  }
}
