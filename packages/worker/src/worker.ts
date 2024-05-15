import TelegramExecutionContext from '../../main/src/ctx';
import TelegramBot from '../../main/src/telegram_bot';

export interface Environment {
	SECRET_TELEGRAM_API_TOKEN: string;
	SECRET_TELEGRAM_API_TOKEN2: string;
	SECRET_TELEGRAM_API_TOKEN3: string;
	AI: Ai;
	DB: D1Database;
	R2: R2Bucket;
}

type promiseFunc<T> = (resolve: (result: T) => void, reject: (e?: Error) => void) => Promise<T>;

function wrapPromise<T>(func: promiseFunc<T>, time = 1000) {
	return new Promise((resolve, reject) => {
		return setTimeout(() => {
			func(resolve, reject);
		}, time);
	});
}

export default {
	fetch: async (request: Request, env: Environment, ctx: ExecutionContext) => {
		const tuxrobot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN);
		const duckduckbot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN2);
		const translatepartybot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN3);
		await Promise.all([
			tuxrobot
				.on('code', async function (context: TelegramExecutionContext) {
					switch (context.update_type) {
						case 'message':
							const prompt = context.update.message?.text?.toString().split(' ').slice(1).join(' ') ?? '';
							const messages = [{ role: 'user', content: prompt }];
							let response: AiTextGenerationOutput;
							try {
								response = await env.AI.run('@hf/thebloke/deepseek-coder-6.7b-instruct-awq', { messages });
							} catch (e) {
								console.log(e);
								await context.reply(`Error: ${e}`);
								return new Response('ok');
							}
							if ('response' in response) {
								await context.reply(response.response ?? '');
							}
							break;

						default:
							break;
					}
					return new Response('ok');
				})
				.on(':photo', async function (context: TelegramExecutionContext) {
					const file_id = context.update.message?.photo?.pop()?.file_id;
					const blob = await context.getFile(file_id as string);
					const input = {
						image: [...new Uint8Array(blob)],
						prompt: 'Generate a caption for this image',
						max_tokens: 512,
					};
					let response: AiImageToTextOutput;
					try {
						response = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', input);
					} catch (e) {
						console.log(e);
						await context.reply(`Error: ${e}`);
						return new Response('ok');
					}
					await context.replyPhoto(file_id as string, response.description);
					return new Response('ok');
				})
				.on('photo', async function (context: TelegramExecutionContext) {
					switch (context.update_type) {
						case 'message': {
							const prompt = context.update.message?.text?.toString() ?? '';
							let photo: AiTextToImageOutput;
							try {
								photo = await env.AI.run('@cf/lykon/dreamshaper-8-lcm', { prompt });
							} catch (e) {
								console.log(e);
								await context.reply(`Error: ${e}`);
								return new Response('ok');
							}
							const photo_file = new File([await new Response(photo).blob()], 'photo');
							const id = crypto.randomUUID();
							await env.R2.put(id, photo_file);
							await context.replyPhoto(`https://r2.seanbehan.ca/${id}`);
							ctx.waitUntil(wrapPromise(async () => await env.R2.delete(id), 5000));
							break;
						}
						case 'inline': {
							const prompt = context.update.inline_query?.query.toString().split(' ').slice(1).join(' ') ?? '';
							let photo: AiTextToImageOutput;
							try {
								photo = await env.AI.run('@cf/lykon/dreamshaper-8-lcm', { prompt });
							} catch (e) {
								console.log(e);
								await context.reply(`Error: ${e}`);
								return new Response('ok');
							}
							const photo_file = new File([await new Response(photo).blob()], 'photo');
							const id = crypto.randomUUID();
							await env.R2.put(id, photo_file);
							await context.replyPhoto(`https://r2.seanbehan.ca/${id}`);
							ctx.waitUntil(wrapPromise(async () => await env.R2.delete(id), 5000));
							break;
						}

						default:
							break;
					}
					return new Response('ok');
				})
				.on('clear', async function (context: TelegramExecutionContext) {
					switch (context.update_type) {
						case 'message':
							await env.DB.prepare('DELETE FROM Messages WHERE userId=?').bind(context.update.message?.from.id).run();
							await context.reply('history cleared');
							break;

						default:
							break;
					}
					return new Response('ok');
				})
				.on('default', async function (context: TelegramExecutionContext) {
					switch (context.update_type) {
						case 'message': {
							const prompt = context.update.message?.text?.toString() ?? '';
							const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE userId=?')
								.bind(context.update.inline_query ? context.update.inline_query.from.id : context.update.message?.from.id)
								.all();
							const message_history = results.map((col) => ({ role: 'system', content: col.content as string }));
							const messages = [
								...message_history,
								{
									role: 'user',
									content: prompt,
								},
							];
							let response: AiTextGenerationOutput;
							try {
								response = await env.AI.run('@cf/meta/llama-3-8b-instruct', { messages, max_tokens: 150 });
							} catch (e) {
								console.log(e);
								await context.reply(`Error: ${e}`);
								return new Response('ok');
							}
							if ('response' in response) {
								await context.reply(response.response ?? '');
							}
							await env.DB.prepare('INSERT INTO Messages (id, userId, content) VALUES (?, ?, ?)')
								.bind(
									crypto.randomUUID(),
									context.update.inline_query ? context.update.inline_query.from.id : context.update.message?.from.id,
									'[INST] ' + prompt + ' [/INST]' + '\n' + response,
								)
								.run();
							break;
						}
						case 'inline': {
							const messages = [
								{
									role: 'user',
									content: context.update.inline_query?.query.toString() ?? '',
								},
							];
							let response: AiTextGenerationOutput;
							try {
								response = await env.AI.run('@cf/meta/llama-3-8b-instruct', { messages, max_tokens: 100 });
							} catch (e) {
								console.log(e);
								await context.reply(`Error: ${e}`);
								return new Response('ok');
							}
							if ('response' in response) {
								await context.reply(response.response ?? '');
							}
							break;
						}

						default:
							break;
					}
					return new Response('ok');
				})
				.handle(request.clone()),
			duckduckbot
				.on('default', async function (context: TelegramExecutionContext) {
					switch (context.update_type) {
						case 'message': {
							await context.reply('https://duckduckgo.com/?q=' + encodeURIComponent(context.update.message?.text?.toString() ?? ''));
							break;
						}
						case 'inline': {
							await context.reply('https://duckduckgo.com/?q=' + encodeURIComponent(context.update.inline_query?.query ?? ''));
							break;
						}

						default:
							break;
					}
					return new Response('ok');
				})
				.handle(request.clone()),
			translatepartybot
				.on('default', async function (context: TelegramExecutionContext) {
					switch (context.update_type) {
						case 'inline': {
							const translated_text = await fetch(
								'https://clients5.google.com/translate_a/t?client=at&sl=auto&tl=en&q=' +
									encodeURIComponent(context.update.inline_query?.query.toString() ?? ''),
							)
								.then((r) => r.json())
								.then((json) => (json as [string[]])[0].slice(0, -1).join(' '));
							await context.reply(translated_text ?? '');
							break;
						}

						default:
							break;
					}

					return new Response('ok');
				})
				.handle(request.clone()),
		]);
		return new Response('ok');
	},
};
