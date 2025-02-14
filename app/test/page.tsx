'use client'
import { supabase } from '@/lib/supabaseClient'
import { useEffect, useState } from 'react'

export default function TestPage() {
  const [status, setStatus] = useState<string>('Checking connection...')

  useEffect(() => {
    async function testConnection() {
      try {
        // Intentar insertar un registro de prueba
        const { data, error: insertError } = await supabase
          .from('canvas_states')
          .insert([
            {
              state: 'test_connection',
            }
          ])
          .select()

        if (insertError) throw insertError

        // Intentar leer los registros
        const { data: readData, error: readError } = await supabase
          .from('canvas_states')
          .select('*')
          .limit(5)

        if (readError) throw readError

        setStatus(`Connection successful! Found ${readData.length} records.`)
      } catch (error) {
        console.error('Error:', error)
        setStatus(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    testConnection()
  }, [])

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">Supabase Connection Test</h1>
      <div className="p-4 border rounded">
        <p>{status}</p>
      </div>
    </div>
  )
} 