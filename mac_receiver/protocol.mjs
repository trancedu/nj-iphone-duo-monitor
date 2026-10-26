import {createHash, timingSafeEqual} from 'node:crypto';
import net from 'node:net';

export class Stop extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function privateIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export const normalizeIP = ip => ip?.replace(/^::ffff:/, '');
export function authorized(header, secret) {
  const hash = x => createHash('sha256').update(x).digest();
  return typeof header === 'string' && timingSafeEqual(hash(header), hash(`Bearer ${secret}`));
}
export function productURL(input) {
  if (typeof input !== 'string' || input.length > 1024 || input.includes('\\')) throw new Stop('invalid_product_url');
  let u; try { u = new URL(input); } catch { throw new Stop('invalid_product_url'); }
  if (u.origin !== 'https://www.apple.com' || u.username || u.password || u.search || u.hash ||
      !/^\/shop\/buy-iphone\/[a-z0-9-]+\/\d+(?:\.\d+)?-inch-display-(?:256gb|512gb|1tb|2tb)-[a-z0-9-]+-unlocked\/?$/.test(u.pathname) ||
      /%|\/\.|\/\//.test(u.pathname)) throw new Stop('invalid_product_url');
  return u.href;
}
export function validateEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Stop('invalid_event');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(raw.event_id || '')) throw new Stop('invalid_event_id');
  if (typeof raw.detected_at !== 'string' || raw.detected_at.length > 64 ||
      !/(Z|[+-]\d\d:\d\d)$/.test(raw.detected_at) || !Number.isFinite(Date.parse(raw.detected_at))) throw new Stop('invalid_timestamp');
  const event = {event_id:raw.event_id, detected_at:raw.detected_at, product_url:productURL(raw.product_url)};
  for (const key of ['store_id','store_name']) {
    if (raw[key] != null) {
      if (typeof raw[key] !== 'string' || raw[key].length > 200 || /[\x00-\x1f]/.test(raw[key])) throw new Stop('invalid_store');
      event[key] = raw[key];
    }
  }
  return event;
}
export function expectedProduct(input) {
  const u = new URL(productURL(input));
  const [,family,display,capacity,color] = u.pathname.match(/\/buy-iphone\/([^/]+)\/(\d+(?:\.\d+)?)-inch-display-(256gb|512gb|1tb|2tb)-(.+)-unlocked\/?$/);
  let model = family.replace(/^iphone/, 'iPhone').replaceAll('-', ' ');
  model = model.replace(/\bpro\b/g,'Pro').replace(/\bduo\b/g,'Duo').replace(/\bair\b/g,'Air');
  if (family.endsWith('-pro') && Number(display) >= 6.7) model += ' Max';
  return `${model} ${capacity.toUpperCase()} ${color.split('-').map(s=>s[0].toUpperCase()+s.slice(1)).join(' ')}`;
}
export const escaped = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const productPattern = url => new RegExp('^\\s*'+expectedProduct(url).split(/\s+/).map(escaped).join('\\s+')+'\\s*$', 'i');
export function fingerprint(event) { return createHash('sha256').update(JSON.stringify(event)).digest('hex'); }
