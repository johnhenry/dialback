import { invertedAsyncIterator } from "./index.mjs";

/**
 * @param {import('../types/types.d.ts').Connection} connection
 * @param {import('../types/types.d.ts').ConnectionOptions} options
 * @returns {[
 *   (data: any) => void,
 *   AsyncGenerator<any, void, unknown>,
 *   () => void
 * ]}
 */
const doConnection = (
  connection,
  {
    filter = () => true,
    transform = (x) => ({ ...x }),
    showSent,
    showFiltered,
    showRecieved,
  } = {
    filter: () => true,
    transform: (x) => ({ ...x }),
  }
) => {
  try {
    const send = (data) => {
      if (showSent) {
        console.log("SENT", data);
      }
      connection.send(JSON.stringify(transform(data)));
    };
    const [generator, enqueue] = invertedAsyncIterator();
    connection.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (showRecieved) {
        console.log("RECIEVED", data);
      }
      if (filter(data)) {
        if (showFiltered) {
          console.log("FILTERED", data);
        }
        enqueue(data);
      }
    });
    return [send, generator(), connection.close.bind(connection)];
  } catch (error) {
    console.error(error);
  }
};

export { doConnection };
export default doConnection;
