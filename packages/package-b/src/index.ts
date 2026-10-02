import { add } from "@poc/package-a";

export const sum = (numbers: number[]): number => numbers.reduce(add, 0);
