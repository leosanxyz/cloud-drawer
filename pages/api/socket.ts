import { Server } from "socket.io"
import type { NextApiRequest } from "next"
import type { Socket as NetSocket } from "net"
import type { Server as HTTPServer } from "http"

interface SocketServer extends HTTPServer {
  io?: Server
}

interface SocketWithIO extends NetSocket {
  server: SocketServer
}

interface NextApiResponseWithSocket extends NextApiRequest {
  socket: SocketWithIO
}

export default function SocketHandler(req: NextApiResponseWithSocket, res: any) {
  if (res.socket.server.io) {
    console.log("Socket is already running")
  } else {
    console.log("Socket is initializing")
    const io = new Server(res.socket.server)
    res.socket.server.io = io

    io.on("connection", (socket) => {
      socket.on("draw", (data) => {
        socket.broadcast.emit("draw", data)
      })
    })
  }
  res.end()
}

