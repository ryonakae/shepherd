export function encodeJsonLine(value: unknown): string {
  const encoded = JSON.stringify(value);

  if (encoded === undefined) {
    throw new TypeError("JSON Lines values must be JSON-serializable");
  }

  return `${encoded}\n`;
}

export class JsonLineDecoder {
  #buffer = "";

  push(chunk: string): unknown[] {
    this.#buffer += chunk;

    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";

    return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line));
  }

  flush(): unknown[] {
    if (this.#buffer.length === 0) {
      return [];
    }

    const line = this.#buffer;
    this.#buffer = "";
    return [JSON.parse(line)];
  }
}
