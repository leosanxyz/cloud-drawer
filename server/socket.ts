import { Server } from 'socket.io'
import { supabase } from '../lib/supabaseClient'

// Eliminamos la variable canvasState ya que ahora usaremos Supabase
export default function socketHandler(io: Server) {
  io.on('connection', async (socket) => {
    // Cuando un cliente solicita el estado del canvas
    socket.on('requestCanvasState', async () => {
      try {
        console.log('Fetching canvas state...')
        const { data, error } = await supabase
          .from('canvas_states')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
        
        if (error) {
          console.error('Error fetching state:', error)
          throw error
        }
        
        const currentState = data?.[0]?.state || ''
        console.log('Sending canvas state to client')
        socket.emit('canvasState', currentState)
      } catch (error) {
        console.error('Error fetching canvas state:', error)
        socket.emit('canvasState', '')
      }
    })

    // Cuando un cliente guarda un nuevo estado
    socket.on('saveCanvasState', async (imageData: string) => {
      try {
        console.log('Saving new canvas state...')
        const { error } = await supabase
          .from('canvas_states')
          .insert([
            {
              state: imageData,
              created_at: new Date().toISOString()
            }
          ])
        
        if (error) {
          console.error('Error saving state:', error)
          throw error
        }
        
        console.log('Broadcasting new state to other clients')
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