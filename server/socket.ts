import { Server } from 'socket.io'
import { supabase } from '../lib/supabaseClient'

// Eliminamos la variable canvasState ya que ahora usaremos Supabase
export default function socketHandler(io: Server) {
  // Configuración para Vercel
  io.engine.on("connection", (socket) => {
    socket.transport.on("upgrade", () => {
      socket.transport.upgrade();
    });
  });

  io.on('connection', async (socket) => {
    // Cuando un cliente solicita el estado del canvas
    socket.on('requestCanvasState', async () => {
      try {
        const { data, error } = await supabase
          .from('canvas_states')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
        
        if (error) throw error
        
        const currentState = data?.[0]?.state || ''
        socket.emit('canvasState', currentState)
      } catch (error) {
        console.error('Error fetching canvas state:', error)
        socket.emit('canvasState', '')
      }
    })

    // Cuando un cliente guarda un nuevo estado
    socket.on('saveCanvasState', async (imageData: string) => {
      try {
        const { error } = await supabase
          .from('canvas_states')
          .insert([
            {
              state: imageData,
              created_at: new Date().toISOString()
            }
          ])
        
        if (error) throw error
        
        // Emitir a todos los clientes excepto al que envió
        socket.broadcast.emit('canvasState', imageData)
      } catch (error) {
        console.error('Error saving canvas state:', error)
      }
    })

    // Manejar los eventos de dibujo existentes
    socket.on('draw', (data) => {
      socket.broadcast.emit('draw', data)
    })
  })
} 