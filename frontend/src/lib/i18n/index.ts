import ru from './ru.json';

type Params = Record<string, string | number>;
const dictionaries: Record<string, Record<string, string>> = { ru };

export function t(key: string, params?: Params, locale = 'ru'): string {
  const template = dictionaries[locale]?.[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}

export function plural(count: number, forms: { one: string; few: string; many: string }): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms.one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms.few;
  return forms.many;
}
