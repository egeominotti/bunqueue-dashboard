declare const maybe: { value: string } | undefined;

maybe && maybe.value;

export function choose(flag: boolean): string {
  if (flag) return 'yes';
  else return 'no';
}

type OnlyType = { value: string };
export { OnlyType };

debugger;

export function unreachable(): number {
  return 1;
  return 2;
}

export const duplicateKeys = { value: 1, value: 2 };

declare const optionalObject: { nested: { value: string } } | undefined;
(optionalObject?.nested).value;
