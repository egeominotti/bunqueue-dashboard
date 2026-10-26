let explicit: number;
explicit = 1;
explicit += 1;

let initialized = 1;
initialized += 1;
const { destructured } = { destructured: 1 };

for (const key in { value: 1 }) console.log(key);
for (let key in { value: 1 }) {
  key = `${key}!`;
  console.log(key);
}
for (var key in { value: 1 }) console.log(key);
for (let value of [1]) {
  value += 1;
  console.log(value);
}
for (var value of [1]) console.log(value);

export { explicit, initialized, destructured };
