// @types/ioredis-mock pins ioredis 5's types; this app is on 6. The tests cast the mock
// to ioredis's `Redis` anyway, so all that is needed here is that the import exists.
declare module "ioredis-mock" {
	const RedisMock: new () => unknown;
	export default RedisMock;
}
