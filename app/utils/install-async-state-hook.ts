export function installAsyncStackHooks(classType: any) {
  try {
    for (const methodName of Reflect.ownKeys(classType.prototype)) {
      const propertyDescriptor = Reflect.getOwnPropertyDescriptor(classType.prototype, methodName);
      if (propertyDescriptor && propertyDescriptor.get !== undefined) {
        continue;
      }

      const method = Reflect.get(classType.prototype, methodName);
      if (methodName === 'constructor' || typeof methodName !== 'string' || methodName.startsWith('_') || typeof method !== 'function' || method.constructor.name !== 'AsyncFunction') {
        continue;
      }

      Reflect.set(classType.prototype, methodName, function (this: any, ...args: any[]) {
        const syncStack: any = {};
        Error.captureStackTrace(syncStack);

        return method.call(this, ...args).catch((e: any) => {
          const stack = syncStack.stack.substring(syncStack.stack.indexOf('\n') + 1);
          const clientStack = stack.substring(stack.indexOf('\n'));
          if (e instanceof Error && e.stack && !e.stack.includes(clientStack)) {
            // eslint-disable-next-line no-param-reassign
            e.stack += '\n  -- ASYNC --\n' + stack;
          }
          throw e;
        });
      });
    }
  } catch (e) {
    console.error(e);
  }
}
