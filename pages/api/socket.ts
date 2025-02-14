import { Server as NetServer } from 'http'
import { NextApiRequest } from 'next'
import { Server as ServerIO } from 'socket.io'
import { NextApiResponseServerIO } from '../../types/next'
import socketHandler from '@/server/socket'

export const config = {
  api: {
    bodyParser: false,
  },
}

const ioHandler = (req: NextApiRequest, res: NextApiResponseServerIO) => {
  if (!res.socket.server.io) {
    const path = '/api/socket'
    const httpServer: NetServer = res.socket.server as any
    const io = new ServerIO(httpServer, {
      path: path,
      // Configurar los transportes aquí
      transports: ['websocket', 'polling'],
      addTrailingSlash: false,
    })
    
    socketHandler(io)
    res.socket.server.io = io
  }
  res.end()
}

export default ioHandler

