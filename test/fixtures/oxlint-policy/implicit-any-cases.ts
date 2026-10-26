var functionScoped;
functionScoped = 1;

function readNested() {
  let nested;
  nested = 1;
  return nested;
}

declare let ambient;
let first, second: number;
first = 1;
second = 2;

for (let index; ; ) {
  index = 0;
  console.log(index);
  break;
}

export { functionScoped, readNested, ambient, first, second };
