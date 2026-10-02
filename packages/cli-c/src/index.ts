import { sum } from "@poc/package-b";

export const run = (args: string[]): string => {
	const numbers = args.map((arg) => {
		const n = Number(arg);
		if (arg.trim() === "" || Number.isNaN(n))
			throw new Error(`Not a number: ${arg}`);
		return n;
	});
	return String(sum(numbers));
};
