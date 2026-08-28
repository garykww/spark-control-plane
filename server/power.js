import dgram from 'node:dgram';
import { createRunner } from './exec/index.js';

/*
 * Power actions are the only place this dashboard writes to a node. They are
 * deliberately narrow: three fixed commands, no user-supplied shell text, and
 * shutdown/reboot are refused for the machine hosting the dashboard itself
 * (which would take the dashboard down with it).
 */

const ACTIONS = {
  shutdown: 'sudo -n shutdown -h now',
  reboot: 'sudo -n reboot',
};

export async function powerAction(node, action) {
  const command = ACTIONS[action];
  if (!command) throw Object.assign(new Error(`unknown power action: ${action}`), { status: 400 });

  if (node.connection === 'local') {
    throw Object.assign(
      new Error('refusing to power off the host running the dashboard'),
      { status: 400 },
    );
  }

  const runner = createRunner(node);
  try {
    /*
     * The connection drops as the node goes down, so a non-zero exit here is
     * expected and not treated as failure. Only an auth/connect error - which
     * surfaces before the command runs - is worth reporting.
     */
    const { stderr } = await runner.run(command, 6000);
    const message = stderr.trim();
    if (/permission denied|sudo:|password is required/i.test(message)) {
      throw Object.assign(
        new Error(`passwordless sudo is not configured for ${node.sshUser} on ${node.name}`),
        { status: 400 },
      );
    }
    return { ok: true, action, node: node.name };
  } finally {
    await runner.close?.();
  }
}

/*
 * Wake-on-LAN magic packet: six 0xFF bytes followed by the target MAC repeated
 * sixteen times, broadcast to the subnet on port 9.
 */
export function buildMagicPacket(macAddress) {
  const bytes = macAddress.split(/[:-]/).map((b) => Number.parseInt(b, 16));
  if (bytes.length !== 6 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw Object.assign(new Error(`invalid MAC address: ${macAddress}`), { status: 400 });
  }

  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i += 1) {
    Buffer.from(bytes).copy(packet, 6 + i * 6);
  }
  return packet;
}

export function wakeOnLan(macAddress, broadcastAddress = '255.255.255.255') {
  const packet = buildMagicPacket(macAddress);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const fail = (err) => {
      socket.close();
      reject(err);
    };

    socket.once('error', fail);
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, 9, broadcastAddress, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve({ ok: true, mac: macAddress, broadcast: broadcastAddress });
      });
    });
  });
}
