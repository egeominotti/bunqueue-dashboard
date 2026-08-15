export function WarningFixture({ items }: { items: string[] }) {
  return <>{items.map((item, index) => <span key={index}>{item}</span>)}</>;
}
